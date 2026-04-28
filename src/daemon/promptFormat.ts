import path from 'node:path';
import type { PreToolUsePayload, NotificationPayload } from '../core/types.js';
import type { SleepingSnapshot } from './sleeping.js';
import { readFirstUserMessage, readLastAssistantText } from './transcript.js';

export interface PromptFormatContext {
  hostname: string;
  sleeping: SleepingSnapshot;
}

const FIRST_USER_MAX = 60;
const ASSISTANT_TEXT_MAX = 200;
const TOOL_SUMMARY_MAX = 200;

export async function formatPermissionPrompt(
  p: PreToolUsePayload,
  ctx: PromptFormatContext,
): Promise<string> {
  const header = await buildHeader(p.cwd, p.transcript_path, ctx);
  const intent = await buildIntentLine(p.transcript_path);
  const summary = summarizeToolInput(p.tool_name, p.tool_input);
  return `${header}${intent}\n\nPode rodar?\n${p.tool_name}: ${summary}`;
}

export async function formatNotification(
  p: NotificationPayload,
  ctx: PromptFormatContext,
): Promise<string> {
  const header = await buildHeader(p.cwd, p.transcript_path, ctx);
  const intent = await buildIntentLine(p.transcript_path);
  const body = p.message ?? 'Claude Code precisa de atenção.';
  return `${header}${intent}\n\n${body}`;
}

async function buildHeader(
  cwd: string | undefined,
  transcriptPath: string | undefined,
  ctx: PromptFormatContext,
): Promise<string> {
  if (ctx.sleeping.active && cwd && samePath(cwd, ctx.sleeping.worktreePath)) {
    return `[${ctx.hostname} / 💤 ${stripSlugSuffix(ctx.sleeping.slug)}]`;
  }
  const parts = [ctx.hostname];
  const folder = projectName(cwd);
  if (folder) parts.push(folder);
  if (transcriptPath) {
    const firstUser = await readFirstUserMessage(transcriptPath);
    if (firstUser) parts.push(`"${truncate(firstUser, FIRST_USER_MAX)}"`);
  }
  return `[${parts.join(' / ')}]`;
}

async function buildIntentLine(transcriptPath: string | undefined): Promise<string> {
  if (!transcriptPath) return '';
  const text = await readLastAssistantText(transcriptPath);
  if (!text) return '';
  return `\n💭 ${truncate(text, ASSISTANT_TEXT_MAX)}`;
}

function projectName(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function stripSlugSuffix(slug: string): string {
  return slug.replace(/-[a-z0-9]{6}$/, '');
}

function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    return truncate(input.command, TOOL_SUMMARY_MAX);
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof input.file_path === 'string') {
    return input.file_path;
  }
  return truncate(JSON.stringify(input), TOOL_SUMMARY_MAX);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
