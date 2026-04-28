import fsp from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';

export interface AllowlistData {
  allow: string[];
  deny: string[];
}

const TOOLS_WITH_FILE_PATH = new Set(['Edit', 'Write', 'Read']);

interface ParsedPattern {
  tool: string;
  inner: string | null; // null = plain `ToolName` (any call)
}

function parsePattern(pattern: string): ParsedPattern | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(pattern.trim());
  if (!m) return null;
  return { tool: m[1], inner: m[2] === undefined ? null : m[2] };
}

function matchBash(command: string, inner: string): boolean {
  if (inner.endsWith(':*')) {
    const prefix = inner.slice(0, -2).trim();
    if (!prefix) return false;
    const prefixTokens = prefix.split(/\s+/);
    const cmdTokens = command.trim().split(/\s+/);
    if (cmdTokens.length < prefixTokens.length) return false;
    for (let i = 0; i < prefixTokens.length; i++) {
      if (cmdTokens[i] !== prefixTokens[i]) return false;
    }
    return true;
  }
  return command === inner;
}

function matchFilePath(filePath: string, inner: string): boolean {
  // Claude Code uses //path for absolute on Unix-like; minimatch handles it
  // when we collapse leading double-slash to a single slash. For Windows-style
  // absolute paths we leave them as-is (drive letter prefix).
  const normalized = inner.startsWith('//') ? inner.slice(1) : inner;
  if (filePath === inner || filePath === normalized) return true;
  return minimatch(filePath, normalized);
}

export function matchPattern(toolName: string, toolInput: Record<string, unknown>, pattern: string): boolean {
  const parsed = parsePattern(pattern);
  if (!parsed) return false;
  if (parsed.tool !== toolName) return false;
  if (parsed.inner === null) return true; // plain tool name = match any call

  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : null;
    if (command === null) return false;
    return matchBash(command, parsed.inner);
  }
  if (TOOLS_WITH_FILE_PATH.has(toolName)) {
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
    if (filePath === null) return false;
    return matchFilePath(filePath, parsed.inner);
  }
  // Unknown tool with parameterized pattern: out of scope, fall through.
  return false;
}

export function matchAny(
  toolName: string,
  toolInput: Record<string, unknown>,
  patterns: string[],
): boolean {
  return patterns.some((p) => matchPattern(toolName, toolInput, p));
}

export async function loadAllowlist(cwd: string): Promise<AllowlistData> {
  const file = path.join(cwd, '.claude', 'settings.local.json');
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch {
    return { allow: [], deny: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { allow: [], deny: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { allow: [], deny: [] };
  const perms = (parsed as { permissions?: unknown }).permissions;
  if (!perms || typeof perms !== 'object') return { allow: [], deny: [] };
  const allow = (perms as { allow?: unknown }).allow;
  const deny = (perms as { deny?: unknown }).deny;
  return {
    allow: Array.isArray(allow) ? allow.filter((s): s is string => typeof s === 'string') : [],
    deny: Array.isArray(deny) ? deny.filter((s): s is string => typeof s === 'string') : [],
  };
}
