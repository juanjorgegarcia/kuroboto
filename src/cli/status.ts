import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { readPid, isProcessAlive, checkHealth } from './util.js';
import { CONFIG_FILE, WATCHDOG_PID_FILE } from '../config/paths.js';
import { loadMode } from '../daemon/state.js';

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold('kuroboto status'));
  console.log(`  config: ${CONFIG_FILE}`);

  const watchdogPid = await readWatchdogPidFile();
  const watchdogAlive = watchdogPid !== null && isProcessAlive(watchdogPid);
  const watchdogLabel =
    watchdogPid === null
      ? chalk.dim('(none)')
      : watchdogAlive
        ? chalk.green(`alive (PID=${watchdogPid})`)
        : chalk.red(`dead (stale PID=${watchdogPid})`);
  console.log(`  watchdog: ${watchdogLabel}`);

  const pid = await readPid();
  const alive = pid !== null && isProcessAlive(pid);
  const pidLabel =
    pid === null
      ? chalk.dim('(none)')
      : alive
        ? chalk.green(`alive (PID=${pid})`)
        : chalk.red(`dead (stale PID=${pid})`);
  console.log(`  daemon: ${pidLabel}`);

  // Split-brain: watchdog dead but daemon alive — happens if the watchdog
  // was killed by hand. The daemon will keep running but no one is
  // supervising it, so the next crash falls back to the original Bug C.
  if (watchdogPid !== null && !watchdogAlive && alive) {
    console.log(
      `  ${chalk.yellow('!! split-brain: watchdog gone but daemon still up — kuroboto stop && kuroboto start --detach to recover')}`,
    );
  }

  const health = await checkHealth();
  if (health.ok) {
    console.log(`  health: ${chalk.green('ok')} uptime=${health.data.uptimeSec}s pending=${health.data.pending}`);
  } else {
    console.log(`  health: ${chalk.red('unreachable')} ${chalk.dim(health.error)}`);
  }

  const mode = await loadMode();
  console.log(`  mode: ${chalk.cyan(mode)}`);

  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const installed = await detectInstalledHooks(settingsPath);
  if (installed === null) {
    console.log(`  hooks: ${chalk.yellow(`(no settings.json at ${settingsPath})`)}`);
  } else if (installed.length === 0) {
    console.log(`  hooks: ${chalk.yellow('not installed — run `kuroboto init`')}`);
  } else {
    console.log(`  hooks: ${chalk.green(installed.join(', '))}`);
  }
}

async function readWatchdogPidFile(): Promise<number | null> {
  try {
    const raw = await fsp.readFile(WATCHDOG_PID_FILE, 'utf-8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

async function detectInstalledHooks(settingsPath: string): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(settingsPath, 'utf-8');
  } catch {
    return null;
  }
  let json: { hooks?: Record<string, HookEntry[]> };
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const hooks = json.hooks ?? {};
  const found: string[] = [];
  for (const event of ['Notification', 'PreToolUse', 'Stop']) {
    const blocks = hooks[event];
    if (!Array.isArray(blocks)) continue;
    const hasKuroboto = blocks.some((b) =>
      Array.isArray(b.hooks) && b.hooks.some((h) => typeof h.command === 'string' && h.command.includes('kuroboto')),
    );
    if (hasKuroboto) found.push(event);
  }
  return found;
}
