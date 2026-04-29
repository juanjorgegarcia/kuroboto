import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import chalk from 'chalk';
import { startDaemon } from '../daemon/lifecycle.js';
import { loadConfig } from '../config/load.js';
import { CONFIG_DIR, STARTUP_LOG_FILE } from '../config/paths.js';
import { checkHealth, sleep } from './util.js';

export interface StartOptions {
  detach?: boolean;
}

export async function startCommand(opts: StartOptions): Promise<void> {
  const existing = await checkHealth();
  if (existing.ok) {
    console.log(chalk.yellow('daemon já está rodando'));
    return;
  }
  if (opts.detach) {
    await startDetached();
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

async function startDetached(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const daemonEntry = path.join(here, '..', 'daemon', 'index.js');

  // Truncate before each start so a stale crash log from an earlier run
  // doesn't get surfaced as the cause of a new failure.
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(STARTUP_LOG_FILE, '');
  const out = openSync(STARTUP_LOG_FILE, 'a');
  const err = openSync(STARTUP_LOG_FILE, 'a');

  const child = spawn(process.execPath, [daemonEntry], {
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
      console.log(chalk.green(`daemon iniciado (PID=${child.pid})`));
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
