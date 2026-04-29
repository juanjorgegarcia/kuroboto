import fsp from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import prompts from 'prompts';
import { loadConfig } from '../config/load.js';
import { parseDuration } from '../daemon/gaming.js';

interface StartOpts {
  prompt?: string;
  plan?: string;
  repo?: string;
  max?: string;
  name?: string;
}

interface CancelOpts {
  all?: boolean;
  yes?: boolean;
}

interface SessionSnap {
  slug: string;
  branch: string;
  worktreePath: string;
  startedAt: number;
  expectedEndAt: number;
}

interface SleepingSnapshot {
  active: SessionSnap[];
  capacity: number;
}

interface CapacityErrorBody {
  error: string;
  capacity: number;
  active: SessionSnap[];
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
    if (res.status === 429) {
      const cap = (await res.json().catch(() => ({}))) as CapacityErrorBody;
      printCapacityReached(cap);
      throw new Error('capacity reached');
    }
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `daemon HTTP ${res.status}`);
  }
  return (await res.json()) as { slug: string; branch: string; worktreePath: string };
}

async function getStatus(): Promise<SleepingSnapshot> {
  const config = await loadConfig();
  const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/sleeping`, {
    headers: { 'X-Kuroboto-Token': config.daemon.authToken },
  });
  if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
  return (await res.json()) as SleepingSnapshot;
}

async function postCancel(body: { slug?: string; all?: boolean }): Promise<{ cancelled: string[] }> {
  const config = await loadConfig();
  const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/sleeping/cancel`, {
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
  return (await res.json()) as { cancelled: string[] };
}

function formatRemaining(snap: SessionSnap): string {
  const remainingMs = snap.expectedEndAt - Date.now();
  if (remainingMs <= 0) return 'expiring';
  const min = Math.ceil(remainingMs / 60_000);
  if (min < 60) return `${min}m remaining`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h remaining` : `${h}h ${m}m remaining`;
}

function printCapacityReached(body: CapacityErrorBody): void {
  console.error(chalk.red(`sleep refused: capacity reached (${body.active.length}/${body.capacity} active)`));
  for (const s of body.active) {
    console.error(`  • ${s.slug.padEnd(46)} ${formatRemaining(s)}`);
  }
  console.error(chalk.dim('\ncancel one with `kuroboto sleeping cancel <slug>` or raise the cap in config (`policy.maxConcurrentSleeps`).'));
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

export async function sleepingCancelCommand(slug: string | undefined, opts: CancelOpts): Promise<void> {
  const status = await getStatus();
  if (status.active.length === 0) {
    console.log(chalk.dim('(no active sleeps)'));
    return;
  }

  // 1. Slug given explicitly — cancel without prompt
  if (slug) {
    const found = status.active.find((s) => s.slug === slug);
    if (!found) {
      console.error(chalk.red(`no active sleep with slug '${slug}'`));
      process.exit(1);
    }
    const r = await postCancel({ slug });
    if (r.cancelled.length > 0) console.log(chalk.green(`sleep cancelled: ${r.cancelled.join(', ')}`));
    else console.log(chalk.dim('no sleep cancelled'));
    return;
  }

  // 2. --all — confirm with all slugs listed (unless --yes)
  if (opts.all) {
    const slugs = status.active.map((s) => s.slug);
    if (!opts.yes) {
      const confirm = await prompts({
        type: 'confirm',
        name: 'val',
        message: `cancel all ${slugs.length}: ${slugs.join(', ')}?`,
        initial: false,
      });
      if (confirm.val !== true) {
        console.log(chalk.dim('aborted'));
        return;
      }
    }
    const r = await postCancel({ all: true });
    console.log(chalk.green(`cancelled ${r.cancelled.length} sleeps: ${r.cancelled.join(', ')}`));
    return;
  }

  // 3. No slug, no --all
  if (status.active.length === 1) {
    const target = status.active[0]!.slug;
    if (!opts.yes) {
      const confirm = await prompts({
        type: 'confirm',
        name: 'val',
        message: `cancel ${target}?`,
        initial: false,
      });
      if (confirm.val !== true) {
        console.log(chalk.dim('aborted'));
        return;
      }
    }
    const r = await postCancel({ slug: target });
    if (r.cancelled.length > 0) console.log(chalk.green(`sleep cancelled: ${target}`));
    return;
  }

  // Multiple active, no slug → cancel most recent
  const sortedByStart = [...status.active].sort((a, b) => b.startedAt - a.startedAt);
  const mostRecent = sortedByStart[0]!.slug;
  if (!opts.yes) {
    const confirm = await prompts({
      type: 'confirm',
      name: 'val',
      message: `cancel most recent (${mostRecent})?`,
      initial: false,
    });
    if (confirm.val !== true) {
      console.log(chalk.dim('aborted'));
      return;
    }
  }
  const r = await postCancel({ slug: mostRecent });
  if (r.cancelled.length > 0) console.log(chalk.green(`sleep cancelled: ${mostRecent}`));
}

export async function sleepingStatusCommand(): Promise<void> {
  const s = await getStatus();
  if (s.active.length === 0) {
    console.log(chalk.dim(`sleep: idle (cap ${s.capacity})`));
    return;
  }
  console.log(chalk.green(`sleep: ${s.active.length} active (cap ${s.capacity})`));
  for (const sess of s.active) {
    console.log(`  • ${sess.slug.padEnd(46)} ${formatRemaining(sess)}`);
  }
}
