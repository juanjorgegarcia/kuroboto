import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import chalk from 'chalk';
import { startDaemon } from '../daemon/lifecycle.js';
import { loadConfig } from '../config/load.js';
import { CONFIG_DIR, STARTUP_LOG_FILE, WATCHDOG_PID_FILE } from '../config/paths.js';
import { checkHealth, isProcessAlive, sleep } from './util.js';

export interface StartOptions {
  detach?: boolean;
  /**
   * When true, skip the watchdog and spawn the daemon directly (legacy
   * pre-Spec-G behavior). Useful for debugging — see the daemon's own
   * stdout/stderr without the watchdog supervision layer in between.
   */
  noWatchdog?: boolean;
}

export async function startCommand(opts: StartOptions): Promise<void> {
  const existing = await checkHealth();
  if (existing.ok) {
    console.log(chalk.yellow('daemon já está rodando'));
    return;
  }
  if (opts.detach) {
    await startDetached(opts);
    return;
  }
  await startForeground();
}

async function startForeground(): Promise<void> {
  const config = await loadConfig();
  await startDaemon(config);
  console.log(chalk.green('daemon rodando (foreground). Ctrl+C para parar.'));
  await new Promise<void>(() => {});
}

async function startDetached(opts: StartOptions): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = opts.noWatchdog
    ? path.join(here, '..', 'daemon', 'index.js')
    : path.join(here, '..', 'watchdog', 'index.js');

  // Guard against double-start: if a watchdog is already running (and
  // checkHealth came back transiently false because the daemon is mid-respawn),
  // a second `kuroboto start --detach` would spawn a duplicate watchdog,
  // overwrite WATCHDOG_PID_FILE, and race with the first on every respawn.
  // (PR #29 review #1.) Stale PID file → unlink + proceed.
  if (!opts.noWatchdog) {
    const existingWatchdogPid = await readWatchdogPid();
    if (existingWatchdogPid !== null) {
      if (isProcessAlive(existingWatchdogPid)) {
        console.log(
          chalk.yellow(`watchdog já está rodando (PID=${existingWatchdogPid}) — sai com kuroboto stop`),
        );
        return;
      }
      // Stale: unlink and proceed.
      await fsp.unlink(WATCHDOG_PID_FILE).catch(() => undefined);
    }
  }

  // Truncate before each start so a stale crash log from an earlier run
  // doesn't get surfaced as the cause of a new failure.
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(STARTUP_LOG_FILE, '');
  const out = openSync(STARTUP_LOG_FILE, 'a');
  const err = openSync(STARTUP_LOG_FILE, 'a');

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();

  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const r = await checkHealth();
    if (r.ok) {
      const label = opts.noWatchdog ? 'daemon' : 'watchdog';
      console.log(chalk.green(`daemon iniciado (${label} PID=${child.pid})`));
      return;
    }
    if (exitInfo !== null) {
      throw new Error(await formatStartupCrash(exitInfo));
    }
    await sleep(250);
  }
  throw new Error(
    `daemon não respondeu em 10s. tail do startup log:\n${await readStartupLogTail()}\n\nfull log: ${STARTUP_LOG_FILE}`,
  );
}

async function formatStartupCrash(
  exitInfo: { code: number | null; signal: NodeJS.Signals | null },
): Promise<string> {
  const why = exitInfo.code !== null ? `exit code ${exitInfo.code}` : `signal ${exitInfo.signal}`;
  const tail = await readStartupLogTail();
  return `daemon crashed during startup (${why}):\n${tail}\n\nfull log: ${STARTUP_LOG_FILE}`;
}

async function readWatchdogPid(): Promise<number | null> {
  try {
    const raw = await fsp.readFile(WATCHDOG_PID_FILE, 'utf-8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function readStartupLogTail(maxLines = 30): Promise<string> {
  try {
    const content = await fsp.readFile(STARTUP_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    const tail = lines.slice(-maxLines).join('\n');
    return tail || '(no output captured)';
  } catch {
    return '(startup log unavailable)';
  }
}
