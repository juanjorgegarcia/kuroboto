import chalk from 'chalk';
import type { ClientListEntry } from '../daemon/injectClients.js';
import type { SessionSnap } from '../daemon/sleeping.js';

export interface DaemonInfo {
  pid: number;
  uptimeSec: number;
  startedAt: string;
  hostname: string;
  port: number;
}

export interface PendingCounts {
  permissions: number;
  notifications: number;
  replies: number;
}

export interface GamingSnap {
  active: boolean;
  until: number | null;
}

export interface SleepingSnap {
  active: SessionSnap[];
  capacity: number;
}

export interface TopicsSnap {
  forumMode: boolean;
  count: number;
}

export interface StatusData {
  daemon: DaemonInfo;
  pending: PendingCounts;
  mode: 'here' | 'away';
  gaming: GamingSnap;
  sleeping: SleepingSnap;
  injectClients: ClientListEntry[];
  topics?: TopicsSnap;
}

export interface MergedStatus {
  configPath: string;
  watchdog: { pid: number; alive: boolean } | null;
  daemonPid: number | null;
  daemonAlive: boolean;
  splitBrain: boolean;
  fetchResult:
    | { ok: true; data: StatusData }
    | { ok: false; error: string; errorCode?: string };
  installedHooks: string[] | null;
  mode?: 'here' | 'away';
}

// ─── Humanization helpers ────────────────────────────────────────────────────

/** Convert milliseconds to a compact human-readable duration string. */
export function humanizeDuration(ms: number): string {
  const totalSec = Math.floor(Math.abs(ms) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

/** Format a future/past epoch ms as a countdown or expiry string. */
export function formatCountdown(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff >= 0) return humanizeDuration(diff);
  return `(expirou há ${humanizeDuration(-diff)})`;
}

/** Truncate a path to at most maxLen chars, leading with …/ if trimmed. */
export function truncatePath(p: string, maxLen = 60): string {
  if (p.length <= maxLen) return p;
  const parts = p.replace(/\\/g, '/').split('/');
  let result = p;
  while (result.length > maxLen && parts.length > 1) {
    parts.shift();
    result = `…/${parts.join('/')}`;
  }
  return result;
}

/** Format startedAt ISO string as local time (today) or date+time (other day). */
export function formatStartedAt(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

// ─── Formatters ──────────────────────────────────────────────────────────────

export function formatHumanReadable(s: MergedStatus): string {
  const lines: string[] = [];
  lines.push(chalk.bold('kuroboto status'));
  lines.push(`  config: ${s.configPath}`);

  if (s.watchdog !== null) {
    const wLabel = s.watchdog.alive
      ? chalk.green(`alive (PID=${s.watchdog.pid})`)
      : chalk.yellow(`⚠ stale PID file (PID=${s.watchdog.pid} — process dead)`);
    lines.push(`  watchdog: ${wLabel}`);
  }

  const daemonLabel =
    s.daemonPid === null
      ? chalk.dim('(none)')
      : s.daemonAlive
        ? chalk.green(`alive (PID=${s.daemonPid})`)
        : chalk.red(`dead (stale PID=${s.daemonPid})`);
  lines.push(`  daemon: ${daemonLabel}`);

  if (s.splitBrain) {
    lines.push(
      `  ${chalk.yellow('!! split-brain: watchdog gone but daemon still up — kuroboto stop && kuroboto start --detach to recover')}`,
    );
  }

  if (!s.fetchResult.ok) {
    const errCode = s.fetchResult.errorCode ?? '';
    lines.push(`  health: ${chalk.red('unreachable')} ${chalk.dim(`(${s.fetchResult.error})`)}`);
    const modeLabel = s.mode ? chalk.cyan(s.mode) : chalk.dim('unknown');
    lines.push(`  mode: ${modeLabel} ${chalk.dim('(from disk — daemon offline)')}`);
    lines.push(
      `  ${chalk.dim('(daemon offline — gaming/sleeps/inject/topics indisponíveis)')}`,
    );
    lines.push(renderHooks(s.installedHooks));
    // suppress unused var warning
    void errCode;
    return lines.join('\n');
  }

  const d = s.fetchResult.data;

  const startedStr = formatStartedAt(d.daemon.startedAt);
  lines.push(
    `  health: ${chalk.green('ok')} uptime=${humanizeDuration(d.daemon.uptimeSec * 1000)}, started ${startedStr}`,
  );
  lines.push(
    `  pending=${d.pending.permissions} pendingNotifications=${d.pending.notifications} replies=${d.pending.replies}`,
  );
  lines.push(`  mode: ${chalk.cyan(d.mode)}`);

  // gaming
  if (d.gaming.active) {
    const timerStr =
      d.gaming.until !== null
        ? `expira em ${formatCountdown(d.gaming.until)}`
        : 'sem timer';
    lines.push(`  gaming: ${chalk.yellow(`armed (${timerStr})`)}`);
  } else {
    lines.push(`  gaming: off`);
  }

  // sleeps
  if (d.sleeping.active.length === 0) {
    lines.push(`  sleeps: none active`);
  } else {
    lines.push(`  sleeps: ${d.sleeping.active.length} active (capacity ${d.sleeping.capacity})`);
    for (const sess of d.sleeping.active) {
      const ago = humanizeDuration(Date.now() - sess.startedAt);
      const countdown = formatCountdown(sess.expectedEndAt);
      lines.push(`    💤 ${sess.slug}    ${ago} ago, expira em ${countdown}`);
    }
  }

  // inject clients
  if (d.injectClients.length === 0) {
    lines.push(`  inject clients: none`);
  } else {
    lines.push(`  inject clients: ${d.injectClients.length} registered`);
    for (const c of d.injectClients) {
      lines.push(`    ${c.slug} (PID=${c.pid}, cwd=${truncatePath(c.cwd)})`);
    }
  }

  // topics (only present if telegram channel)
  if (d.topics !== undefined) {
    if (d.topics.forumMode) {
      lines.push(`  topics: forumMode on, ${d.topics.count} mapeados`);
    } else {
      lines.push(`  topics: DM mode (forumMode off)`);
    }
  }

  lines.push(renderHooks(s.installedHooks));
  return lines.join('\n');
}

export function formatJson(s: MergedStatus): string {
  return JSON.stringify(s, null, 2);
}

export function formatQuiet(s: MergedStatus): { text: string; exitCode: number } {
  if (s.daemonAlive && s.fetchResult.ok) {
    return { text: 'daemon: alive', exitCode: 0 };
  }
  return { text: 'daemon: dead', exitCode: 1 };
}

function renderHooks(installed: string[] | null): string {
  if (installed === null) {
    return `  hooks: ${chalk.yellow('(no settings.json found)')}`;
  }
  if (installed.length === 0) {
    return `  hooks: ${chalk.yellow('not installed — run `kuroboto init`')}`;
  }
  return `  hooks: ${chalk.green(installed.join(', '))}`;
}
