import chalk from 'chalk';
import { loadConfig } from '../config/load.js';
import { saveMode, type Mode } from '../daemon/state.js';

async function setMode(mode: Mode): Promise<void> {
  // Always persist locally so the daemon picks it up next boot.
  await saveMode(mode);

  // Try to also push to a running daemon so the change takes effect immediately.
  let config;
  try {
    config = await loadConfig();
  } catch {
    console.log(chalk.green(`mode set to ${mode}`) + chalk.dim(' (saved locally; no kuroboto config found)'));
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2_000);
  try {
    const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/mode`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Kuroboto-Token': config.daemon.authToken,
      },
      body: JSON.stringify({ mode }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      console.log(chalk.green(`mode set to ${mode}`));
      return;
    }
    console.log(chalk.green(`mode set to ${mode}`) + chalk.dim(` (daemon returned HTTP ${res.status})`));
  } catch {
    clearTimeout(timer);
    console.log(chalk.green(`mode set to ${mode}`) + chalk.dim(' (daemon offline; will apply at next start)'));
  }
}

export async function hereCommand(): Promise<void> {
  await setMode('here');
}

export async function awayCommand(): Promise<void> {
  await setMode('away');
}
