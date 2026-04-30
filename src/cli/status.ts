import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readPid, isProcessAlive, fetchStatus } from './util.js';
import { CONFIG_FILE, WATCHDOG_PID_FILE } from '../config/paths.js';
import { loadMode } from '../daemon/state.js';
import {
  formatHumanReadable,
  formatJson,
  formatQuiet,
  type MergedStatus,
} from './statusFormat.js';

interface StatusOptions {
  json?: boolean;
  watch?: number | false;
  quiet?: boolean;
}

export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  if (opts.watch !== undefined && opts.watch !== false) {
    const interval = opts.watch;
    if (typeof interval !== 'number' || isNaN(interval) || interval < 0.5) {
      process.stderr.write('error: --watch interval must be ≥ 0.5s\n');
      process.exit(2);
    }
    await runWatch(interval, opts);
    return;
  }

  const merged = await gatherStatus();
  const exitCode = resolveExitCode(merged, opts);

  if (opts.quiet) {
    const { text } = formatQuiet(merged);
    process.stdout.write(text + '\n');
  } else if (opts.json) {
    process.stdout.write(formatJson(merged) + '\n');
  } else {
    console.log(formatHumanReadable(merged));
  }

  if (exitCode !== 0) process.exit(exitCode);
}

async function runWatch(intervalSec: number, opts: StatusOptions): Promise<void> {
  const render = async (): Promise<void> => {
    process.stdout.write('\x1B[2J\x1B[0f');
    const now = new Date().toLocaleTimeString();
    process.stdout.write(
      `(live, refresh ${intervalSec}s, Ctrl+C pra sair) — ${now}\n`,
    );
    const merged = await gatherStatus();
    if (opts.json) {
      process.stdout.write(formatJson(merged) + '\n');
    } else {
      console.log(formatHumanReadable(merged));
    }
  };

  await render();
  const timer = setInterval(() => {
    render().catch(() => {});
  }, intervalSec * 1000);

  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

async function gatherStatus(): Promise<MergedStatus> {
  const [watchdogPid, daemonPid, fetchResult, installedHooks, fallbackMode] =
    await Promise.all([
      readWatchdogPidFile(),
      readPid(),
      fetchStatus(),
      detectInstalledHooks(path.join(os.homedir(), '.claude', 'settings.json')),
      loadMode().catch(() => 'here' as const),
    ]);

  const daemonAlive = daemonPid !== null && isProcessAlive(daemonPid);
  const watchdog =
    watchdogPid !== null
      ? { pid: watchdogPid, alive: isProcessAlive(watchdogPid) }
      : null;
  const splitBrain = watchdog !== null && !watchdog.alive && daemonAlive;

  return {
    configPath: CONFIG_FILE,
    watchdog,
    daemonPid,
    daemonAlive,
    splitBrain,
    fetchResult,
    installedHooks,
    mode: fallbackMode,
  };
}

function resolveExitCode(s: MergedStatus, opts: StatusOptions): number {
  if (opts.watch !== undefined && opts.watch !== false) return 0;
  if (!s.daemonAlive || !s.fetchResult.ok) return 1;
  return 0;
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
      Array.isArray(b.hooks) &&
      b.hooks.some((h) => typeof h.command === 'string' && h.command.includes('kuroboto')),
    );
    if (hasKuroboto) found.push(event);
  }
  return found;
}
