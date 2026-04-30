import fsp from 'node:fs/promises';
import chalk from 'chalk';
import { WATCHDOG_PID_FILE } from '../config/paths.js';
import { readPid, isProcessAlive, sleep } from './util.js';

export async function stopCommand(): Promise<void> {
  const watchdogPid = await readWatchdogPid();
  if (watchdogPid !== null && isProcessAlive(watchdogPid)) {
    process.kill(watchdogPid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(watchdogPid)) {
        console.log(chalk.green('watchdog + daemon parados'));
        return;
      }
      await sleep(200);
    }
    console.error(chalk.red('watchdog não parou em 10s'));
    process.exitCode = 1;
    return;
  }

  // Legacy / --no-watchdog path: kill the daemon directly.
  const pid = await readPid();
  if (!pid || !isProcessAlive(pid)) {
    console.log(chalk.yellow('nenhum daemon rodando'));
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      console.log(chalk.green('daemon parado'));
      return;
    }
    await sleep(200);
  }
  console.error(chalk.red('daemon não parou em 10s'));
  process.exitCode = 1;
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
