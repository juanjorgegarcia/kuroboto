import chalk from 'chalk';
import { readAudit, parseSince, type AuditEntry } from '../daemon/audit.js';

export interface AuditCmdOpts {
  since?: string;
  cwd?: string;
  limit?: string;
}

function buildFilter(opts: AuditCmdOpts) {
  return {
    sinceMs: opts.since ? parseSince(opts.since) : undefined,
    cwd: opts.cwd,
    limit: opts.limit ? Number(opts.limit) : undefined,
  };
}

function fmtDecision(e: AuditEntry): string {
  if (e.decision === 'allow') return e.remember ? chalk.green('ALLOW+R') : chalk.green('ALLOW  ');
  if (e.decision === 'deny') return chalk.red('DENY   ');
  return chalk.dim('ASK    ');
}

export async function auditList(opts: AuditCmdOpts): Promise<void> {
  const entries = await readAudit(buildFilter(opts));
  if (entries.length === 0) {
    console.log(chalk.dim('(sem entradas)'));
    return;
  }
  for (const e of entries) {
    const reason = e.reason ? chalk.dim(` reason="${e.reason}"`) : '';
    const cwd = e.cwd ? chalk.dim(` cwd=${e.cwd}`) : '';
    console.log(`${e.ts}  ${fmtDecision(e)}  ${e.tool.padEnd(10)}${cwd}${reason}`);
  }
}

export async function auditExport(opts: AuditCmdOpts): Promise<void> {
  const entries = await readAudit(buildFilter(opts));
  for (const e of entries) process.stdout.write(JSON.stringify(e) + '\n');
}
