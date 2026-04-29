import chalk from 'chalk';
import { parseDuration } from '../daemon/gaming.js';
import { kuroFetch } from './http.js';

interface GamingSnapshot {
  active: boolean;
  until: number | null;
}

async function postGaming(body: { on: boolean; durationMs?: number }): Promise<GamingSnapshot> {
  const res = await kuroFetch<{ ok: boolean; active: boolean; until: number | null } | { error?: string }>(
    '/v1/gaming',
    { method: 'PUT', body, timeoutMs: 2_000 },
  );
  if (!res.ok) {
    const err = res.body as { error?: string };
    throw new Error(err?.error ?? `daemon HTTP ${res.status}`);
  }
  const json = res.body as { active: boolean; until: number | null };
  return { active: json.active, until: json.until };
}

async function getGaming(): Promise<GamingSnapshot> {
  const res = await kuroFetch<GamingSnapshot>('/v1/gaming');
  if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
  return res.body;
}

function formatRemaining(untilMs: number): string {
  const remainingMs = untilMs - Date.now();
  if (remainingMs <= 0) return '0s';
  const totalSec = Math.ceil(remainingMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m${sec}s`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

export async function gamingOnCommand(duration?: string): Promise<void> {
  let durationMs: number | undefined;
  if (duration !== undefined) {
    try {
      durationMs = parseDuration(duration);
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exit(1);
    }
  }
  const snap = await postGaming({ on: true, durationMs });
  if (snap.until) {
    console.log(chalk.green(`gaming on (${formatRemaining(snap.until)} remaining)`));
  } else {
    console.log(chalk.green('gaming on (no timer — off only via `kuroboto gaming off`)'));
  }
}

export async function gamingOffCommand(): Promise<void> {
  await postGaming({ on: false });
  console.log(chalk.green('gaming off'));
}

export async function gamingStatusCommand(): Promise<void> {
  const snap = await getGaming();
  if (!snap.active) {
    console.log(chalk.dim('gaming: off'));
    return;
  }
  if (snap.until === null) {
    console.log(chalk.green('gaming: on') + chalk.dim(' (no timer)'));
  } else {
    console.log(chalk.green('gaming: on') + chalk.dim(` (${formatRemaining(snap.until)} remaining)`));
  }
}
