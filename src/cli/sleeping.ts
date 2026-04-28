import fsp from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../config/load.js';
import { parseDuration } from '../daemon/gaming.js';

interface StartOpts {
  prompt?: string;
  plan?: string;
  repo?: string;
  max?: string;
}

async function postStart(body: { repo: string; prompt?: string; plan?: string; maxDurationMs?: number }) {
  const config = await loadConfig();
  const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/sleeping`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kuroboto-Token': config.daemon.authToken,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `daemon HTTP ${res.status}`);
  }
  return (await res.json()) as { slug: string; branch: string; worktreePath: string };
}

async function getStatus() {
  const config = await loadConfig();
  const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/sleeping`, {
    headers: { 'X-Kuroboto-Token': config.daemon.authToken },
  });
  if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
  return (await res.json()) as { active: boolean; slug?: string; expectedEndAt?: number; worktreePath?: string };
}

async function deleteSession() {
  const config = await loadConfig();
  const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/sleeping`, {
    method: 'DELETE',
    headers: { 'X-Kuroboto-Token': config.daemon.authToken },
  });
  if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
  return (await res.json()) as { ok: boolean; cancelled: boolean };
}

export async function sleepingStartCommand(opts: StartOpts): Promise<void> {
  if (!opts.prompt && !opts.plan) {
    console.error(chalk.red('--prompt or --plan required'));
    process.exit(1);
  }
  if (opts.prompt && opts.plan) {
    console.error(chalk.red('--prompt and --plan are mutually exclusive'));
    process.exit(1);
  }
  let plan: string | undefined;
  if (opts.plan) {
    const planPath = path.resolve(opts.plan);
    plan = await fsp.readFile(planPath, 'utf-8');
  }
  const repo = path.resolve(opts.repo ?? process.cwd());
  const maxDurationMs = opts.max ? parseDuration(opts.max) : undefined;
  const session = await postStart({ repo, prompt: opts.prompt, plan, maxDurationMs });
  console.log(chalk.green(`💤 sleep started`));
  console.log(`  slug:     ${session.slug}`);
  console.log(`  branch:   ${session.branch}`);
  console.log(`  worktree: ${session.worktreePath}`);
  console.log(chalk.dim('Telegram will notify when done. `kuroboto sleeping cancel` to abort.'));
}

export async function sleepingCancelCommand(): Promise<void> {
  const r = await deleteSession();
  if (r.cancelled) console.log(chalk.green('sleep cancelled'));
  else console.log(chalk.dim('no active sleep'));
}

export async function sleepingStatusCommand(): Promise<void> {
  const s = await getStatus();
  if (!s.active) {
    console.log(chalk.dim('sleep: idle'));
    return;
  }
  const remainingMs = (s.expectedEndAt ?? 0) - Date.now();
  const remaining = remainingMs > 0 ? `${Math.ceil(remainingMs / 60_000)}m remaining` : 'expiring';
  console.log(chalk.green(`sleep: active`));
  console.log(`  slug:     ${s.slug}`);
  console.log(`  worktree: ${s.worktreePath}`);
  console.log(`  ${remaining}`);
}
