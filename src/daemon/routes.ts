import type { Express, Request, Response } from 'express';
import type { DaemonContext } from './server.js';
import type { PreToolUsePayload, NotificationPayload } from '../core/types.js';

export function registerRoutes(app: Express, ctx: DaemonContext): void {
  app.get('/v1/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
      pending: ctx.pending.size(),
    });
  });

  app.post('/v1/notify', (req: Request, res: Response) => {
    const payload = req.body as NotificationPayload;
    const text = formatNotification(payload);
    ctx.channel.sendNotification(text).catch((e) => {
      ctx.logger.warn('sendNotification failed', { err: (e as Error).message });
    });
    res.json({ ok: true });
  });

  app.post('/v1/permission', async (req: Request, res: Response) => {
    const payload = req.body as PreToolUsePayload;
    const { requestId, promise } = ctx.pending.create(ctx.config.policy.permissionTimeoutMs);
    const promptText = formatPermissionPrompt(payload);
    try {
      await ctx.channel.sendPrompt({
        requestId,
        text: promptText,
        buttons: [
          { label: '✅ Allow', action: 'allow' },
          { label: '❌ Deny', action: 'deny' },
        ],
      });
    } catch (e) {
      ctx.logger.error('sendPrompt failed', { err: (e as Error).message });
      ctx.pending.resolve(requestId, { decision: 'allow', reason: 'channel unavailable' });
    }
    const decision = await promise;
    res.json(decision);
  });
}

function projectName(cwd: string | undefined): string {
  if (!cwd) return 'unknown';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

function formatNotification(p: NotificationPayload): string {
  const folder = projectName(p.cwd);
  const msg = p.message ?? 'Claude Code precisa de atenção.';
  return `[${folder}] ${msg}`;
}

function formatPermissionPrompt(p: PreToolUsePayload): string {
  const folder = projectName(p.cwd);
  const summary = summarizeToolInput(p.tool_name, p.tool_input);
  return `[${folder}] Pode rodar?\n\n${p.tool_name}: ${summary}`;
}

function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    return truncate(input.command, 200);
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof input.file_path === 'string') {
    return input.file_path;
  }
  const json = JSON.stringify(input);
  return truncate(json, 200);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
