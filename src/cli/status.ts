import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { readPid, isProcessAlive, checkHealth } from './util.js';
import { CONFIG_FILE } from '../config/paths.js';

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold('kuroboto status'));
  console.log(`  config: ${CONFIG_FILE}`);

  const pid = await readPid();
  const alive = pid !== null && isProcessAlive(pid);
  const pidLabel = pid === null ? '(none)' : alive ? chalk.green(`alive (PID=${pid})`) : chalk.red(`dead (stale PID=${pid})`);
  console.log(`  daemon: ${pidLabel}`);

  const health = await checkHealth();
  if (health.ok) {
    console.log(`  health: ${chalk.green('ok')} uptime=${health.data.uptimeSec}s pending=${health.data.pending}`);
  } else {
    console.log(`  health: ${chalk.red('unreachable')} ${chalk.dim(health.error)}`);
  }

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
