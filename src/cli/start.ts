import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import chalk from 'chalk';
import { startDaemon } from '../daemon/lifecycle.js';
import { loadConfig } from '../config/load.js';
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
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const r = await checkHealth();
    if (r.ok) {
      console.log(chalk.green(`daemon iniciado (PID=${child.pid})`));
      return;
    }
    await sleep(250);
  }
  throw new Error('daemon não respondeu em 10s');
}
