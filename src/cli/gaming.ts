import chalk from 'chalk';
import { loadConfig } from '../config/load.js';

async function setGaming(on: boolean): Promise<void> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    console.error(chalk.red('no kuroboto config found — run `kuroboto init`'));
    process.exit(1);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2_000);
  try {
    const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/gaming`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Kuroboto-Token': config.daemon.authToken,
      },
      body: JSON.stringify({ on }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      console.log(chalk.green(`gaming ${on ? 'on' : 'off'}`));
      if (on) console.log(chalk.dim('all permission prompts auto-allowed until `kuroboto gaming off`'));
      return;
    }
    console.error(chalk.red(`daemon returned HTTP ${res.status}`));
    process.exit(1);
  } catch {
    clearTimeout(timer);
    console.error(chalk.red('daemon offline — start it with `kuroboto start -d`'));
    process.exit(1);
  }
}

async function statusGaming(): Promise<void> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    console.error(chalk.red('no kuroboto config found'));
    process.exit(1);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/gaming`, {
      headers: { 'X-Kuroboto-Token': config.daemon.authToken },
    });
    if (!res.ok) {
      console.error(chalk.red(`daemon returned HTTP ${res.status}`));
      process.exit(1);
    }
    const json = (await res.json()) as { gaming: boolean };
    console.log(json.gaming ? chalk.green('gaming: on') : chalk.dim('gaming: off'));
  } catch {
    console.error(chalk.red('daemon offline'));
    process.exit(1);
  }
}

export async function gamingOnCommand(): Promise<void> {
  await setGaming(true);
}
export async function gamingOffCommand(): Promise<void> {
  await setGaming(false);
}
export async function gamingStatusCommand(): Promise<void> {
  await statusGaming();
}
