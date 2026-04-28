import fsp from 'node:fs/promises';
import { AUDIT_FILE, CONFIG_DIR } from '../config/paths.js';

export interface AuditEntry {
  ts: string;
  requestId: string;
  tool: string;
  cwd: string | null;
  decision: 'allow' | 'deny' | 'ask';
  reason: string | null;
  source: string;
  remember: boolean;
}

export interface AuditFilter {
  sinceMs?: number;
  cwd?: string;
  limit?: number;
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n');
}

export async function readAudit(filter: AuditFilter): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(AUDIT_FILE, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const cutoff = filter.sinceMs ? Date.now() - filter.sinceMs : null;
  const lines = raw.split('\n');
  const out: AuditEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      continue;
    }
    if (cutoff !== null && new Date(entry.ts).getTime() < cutoff) continue;
    if (filter.cwd && entry.cwd !== filter.cwd) continue;
    out.push(entry);
  }
  if (filter.limit && out.length > filter.limit) {
    return out.slice(out.length - filter.limit);
  }
  return out;
}

export function parseSince(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`invalid --since value: ${s} (use 30s, 5m, 2h, 7d)`);
  const n = Number(m[1]);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * mult;
}
