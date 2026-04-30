import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.js';
import {
  PID_FILE,
  WATCHDOG_PID_FILE,
  WATCHDOG_LOG_FILE,
  STARTUP_LOG_FILE,
} from '../config/paths.js';
import { appendAudit } from '../daemon/audit.js';
import { nextBackoff, shouldRespawn } from './policy.js';
import { sendWatchdogNotification } from './notify.js';

/**
 * The watchdog: a small supervisor process that spawns the daemon as its
 * own child, listens for `child.on('exit')`, and respawns with exponential
 * backoff. Bug C — daemon dies silently and stays dead — is solved here
 * because parent-child `exit` fires for every cause of child death (JS
 * crash, SIGKILL, OOM, segfault, lid close → child clean up). The watchdog
 * deliberately stays small (~200 LOC, no Telegram polling, no HTTP server,
 * no business logic) so its own failure surface is minimal.
 */

export interface RunWatchdogDeps {
  /** Override daemon entry path — tests point this at a daemon-mock script. */
  daemonEntry?: string;
  /** Override spawn — tests pass in a fake. */
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** Override fetch — tests stub /health responses. */
  fetchImpl?: typeof fetch;
  /** Override clock — tests inject deterministic now/setTimeout. */
  now?: () => number;
  /** Override delay — tests skip real waits. */
  sleep?: (ms: number) => Promise<void>;
  /** When true, skip writing to WATCHDOG_LOG_FILE (used by tests). */
  silent?: boolean;
  /** Override config path discovery — tests pass a synthetic config. */
  loadConfigImpl?: () => Promise<{
    channel: { token: string; chatId: number; forumMode?: boolean };
    daemon: { port: number };
  }>;
  /** Hook fired after each respawn — used by tests + future v2 sleep recovery. */
  onDaemonRespawn?: (pid: number | undefined) => void;
  /** Hook fired when the watchdog gives up, exits, or hits a terminal state. */
  onTerminal?: (reason: 'startup-failure' | 'gave-up' | 'sigterm') => void;
  /** Override paths — tests redirect PID/log writes to a temp dir. */
  paths?: {
    pidFile?: string;
    daemonPidFile?: string;
    logFile?: string;
    startupLog?: string;
  };
  /** Override audit append — tests use a no-op or capture. */
  auditImpl?: (entry: AuditEntry) => Promise<void>;
  /** Override notification sender — tests capture instead of hitting Telegram. */
  notifyImpl?: (text: string) => Promise<boolean>;
  /** Override SIGTERM/SIGINT registration — tests use a controllable hook. */
  signalRegistrar?: (handler: (sig: NodeJS.Signals) => void) => void;
}

interface AuditEntry {
  source: string;
  decision: 'allow' | 'deny';
  reason: string;
}

const HEALTHY_STABILITY_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_INITIAL_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;

interface WatchdogRuntimeState {
  attempt: number;
  everHealthy: boolean;
  respawnTimestamps: number[];
  /**
   * Set once a fresh daemon has been continuously healthy for
   * HEALTHY_STABILITY_MS — then we reset attempt and respawnTimestamps so
   * the full backoff budget is restored for any future crash.
   */
  stabilityTimer: NodeJS.Timeout | null;
}

export async function runWatchdog(deps: RunWatchdogDeps = {}): Promise<number> {
  const pidFile = deps.paths?.pidFile ?? WATCHDOG_PID_FILE;
  const daemonPidFile = deps.paths?.daemonPidFile ?? PID_FILE;
  const logFile = deps.paths?.logFile ?? WATCHDOG_LOG_FILE;
  const startupLog = deps.paths?.startupLog ?? STARTUP_LOG_FILE;

  await fsp.mkdir(path.dirname(pidFile), { recursive: true });

  const log = makeLogger(deps, logFile);
  log('watchdog starting');

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const port = config.daemon.port;
  const channel = config.channel;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const spawnFn = deps.spawn ?? nodeSpawn;
  const daemonEntry = deps.daemonEntry ?? defaultDaemonEntry();
  const notifyImpl =
    deps.notifyImpl ??
    ((text: string) =>
      sendWatchdogNotification({
        token: channel.token,
        chatId: channel.chatId,
        forumMode: channel.forumMode === true,
        text,
        log: (m) => log(m),
      }));
  const auditImpl =
    deps.auditImpl ??
    (async (entry: AuditEntry) => {
      await appendAudit({
        ts: new Date().toISOString(),
        requestId: `watchdog:${new Date().toISOString()}`,
        tool: 'watchdog',
        cwd: null,
        decision: entry.decision,
        reason: entry.reason,
        source: entry.source,
        remember: false,
      });
    });

  await fsp.writeFile(pidFile, String(process.pid));
  log(`watchdog pid file written pid=${process.pid}`);

  const state: WatchdogRuntimeState = {
    attempt: 0,
    everHealthy: false,
    respawnTimestamps: [],
    stabilityTimer: null,
  };

  let child: ChildProcess | null = null;
  let stopping = false;
  // Tracks whether the next successful spawn constitutes a respawn (i.e. the
  // loop has iterated at least once already). The hook fires with the NEW
  // pid — not the dying child's — and only when a respawn actually happens.
  let isRespawn = false;

  // Open the startup log for stdio redirect; on failure log + fall back to a
  // null sink so spawn doesn't throw. Runs inside runWatchdog so it can use
  // the closured logger (PR #29 review #6: silent fallback was masking real
  // permission/FS errors).
  const openLogFd = (file: string): number => {
    try {
      return fs.openSync(file, 'a');
    } catch (e) {
      log(`openLogFd fallback for ${file}: ${(e as Error).message}`);
      return fs.openSync(process.platform === 'win32' ? 'nul' : '/dev/null', 'a');
    }
  };

  const cleanupPidFiles = async (): Promise<void> => {
    await unlinkBest(pidFile);
    await unlinkBest(daemonPidFile);
  };

  const appendAuditSafe = async (entry: AuditEntry): Promise<void> => {
    try {
      await auditImpl(entry);
    } catch (e) {
      log(`audit append failed: ${(e as Error).message}`);
    }
  };

  const sendNotifSafe = async (text: string): Promise<void> => {
    try {
      await notifyImpl(text);
    } catch (e) {
      log(`notif failed: ${(e as Error).message}`);
    }
  };

  const onTerminalNonRespawn = async (
    reason: 'startup-failure' | 'gave-up',
    info: ExitInfo,
  ): Promise<void> => {
    await appendAuditSafe({
      source: reason === 'startup-failure' ? 'watchdog-startup-failure' : 'watchdog-gave-up',
      decision: 'deny',
      reason: reason === 'startup-failure' ? describeExit(info) : '5 retries in 60s',
    });
    if (reason === 'startup-failure') {
      await sendNotifSafe(
        `❌ daemon não respondeu em 10s — investigar config (${describeExit(info)})`,
      );
    } else {
      await sendNotifSafe(
        `❌ watchdog deu up — 5 falhas em 60s. Última: ${describeExit(info)}. Rode kuroboto ohayo quando puder.`,
      );
    }
  };

  const emitRespawnNotif = async (attemptNumber: number, info: ExitInfo): Promise<void> => {
    await sendNotifSafe(`🔄 daemon respawnado (#${attemptNumber}) — ${describeExit(info)}`);
  };

  const handleStopSignal = async (sig: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`watchdog received ${sig} — stopping daemon`);
    deps.onTerminal?.('sigterm');
    if (state.stabilityTimer) clearTimeout(state.stabilityTimer);
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch (e) {
        log(`SIGTERM failed: ${(e as Error).message}`);
      }
      const killed = await waitForExit(child, STOP_GRACE_MS, sleep, now);
      if (!killed) {
        log('daemon did not exit on SIGTERM — escalating to SIGKILL');
        try {
          child.kill('SIGKILL');
        } catch (e) {
          log(`SIGKILL failed: ${(e as Error).message}`);
        }
      }
    }
    await cleanupPidFiles();
    log('watchdog stopped cleanly');
  };

  const registerSignal = deps.signalRegistrar
    ?? ((handler) => {
      process.on('SIGTERM', () => handler('SIGTERM'));
      process.on('SIGINT', () => handler('SIGINT'));
    });
  registerSignal((sig) => {
    void handleStopSignal(sig).then(() => {
      if (!deps.signalRegistrar) process.exit(0);
    });
  });

  // -- main supervision loop --
  while (!stopping) {
    log(`spawning daemon (attempt #${state.attempt + 1})`);
    let spawnedAt = now();
    // Capture FDs into named vars so we can close our own handles after spawn.
    // Otherwise each respawn cycle leaks 2 FDs into the watchdog process
    // (PR #29 review #5).
    let outFd: number | null = null;
    let errFd: number | null = null;
    try {
      outFd = openLogFd(startupLog);
      errFd = openLogFd(startupLog);
      child = spawnFn(process.execPath, [daemonEntry], {
        // stdio shares the startup log so the parent CLI can tail any
        // startup error (PR #23 path stays intact). We don't `detached: true`
        // here — the daemon must be a child of the watchdog so `exit` fires.
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      });
    } catch (e) {
      // Close any FDs we opened before the spawn failed.
      if (outFd !== null) try { fs.closeSync(outFd); } catch { /* best-effort */ }
      if (errFd !== null) try { fs.closeSync(errFd); } catch { /* best-effort */ }
      const detail = `spawn threw: ${(e as Error).message}`;
      log(detail);
      await appendAuditSafe({
        source: 'watchdog-startup-failure',
        decision: 'deny',
        reason: detail,
      });
      await sendNotifSafe(`❌ watchdog não conseguiu iniciar daemon: ${detail}`);
      deps.onTerminal?.('startup-failure');
      await cleanupPidFiles();
      return 1;
    }
    // Close the watchdog's handles to the FDs — the child has its own copies.
    // Without this, every respawn cycle leaks 2 FDs into the watchdog process.
    try { fs.closeSync(outFd); } catch { /* best-effort */ }
    try { fs.closeSync(errFd); } catch { /* best-effort */ }

    // Fire onDaemonRespawn AFTER the new process is spawned, with the NEW
    // pid — not the dying child's. Skipped on the first iteration since that
    // is a fresh start, not a respawn (PR #29 review #2/#3). Putting it here
    // also covers the timeout-respawn path that was missing the hook.
    if (isRespawn) {
      deps.onDaemonRespawn?.(child.pid);
    }

    const exitPromise = waitForChildExit(child);
    const healthy = await waitForHealthy({
      port,
      timeoutMs: HEALTH_INITIAL_TIMEOUT_MS,
      pollIntervalMs: HEALTH_POLL_INTERVAL_MS,
      fetchImpl,
      sleep,
      now,
      exitPromise,
    });

    if (healthy === 'exited-before-healthy') {
      const info = await exitPromise;
      // SIGTERM during startup is the user calling `kuroboto stop` — not a
      // failure. Bail cleanly instead of treating it as a crash and emitting
      // a 'startup-failure' notification.
      if (stopping) break;
      log(`daemon exited before healthy: code=${info.code} signal=${info.signal}`);
      const decision = shouldRespawn({
        everHealthy: state.everHealthy,
        respawnTimestamps: state.respawnTimestamps.filter((ts) => now() - ts < 60_000),
        now: now(),
      });
      if (!decision.respawn) {
        await onTerminalNonRespawn(decision.reason, info);
        deps.onTerminal?.(decision.reason);
        await cleanupPidFiles();
        return 1;
      }
      // /health never 200'd this cycle but we previously knew the daemon
      // was healthy once — runtime crash. Record + backoff.
      state.respawnTimestamps.push(now());
      const wait = nextBackoff(state.attempt);
      state.attempt += 1;
      await appendAuditSafe({
        source: 'watchdog-respawn',
        decision: 'allow',
        reason: describeExit(info),
      });
      await emitRespawnNotif(state.respawnTimestamps.length, info);
      isRespawn = true;
      log(`backoff ${wait}ms before respawn`);
      await sleep(wait);
      continue;
    }

    if (healthy === 'timeout') {
      // SIGTERM during the health-poll window — same logic as the
      // exited-before-healthy guard above.
      if (stopping) break;
      log('daemon /health did not return 200 within 10s');
      // Kill the unhealthy child so it doesn't linger.
      if (child.exitCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          // best-effort
        }
        const stopped = await waitForExit(child, STOP_GRACE_MS, sleep, now);
        if (!stopped) {
          try {
            child.kill('SIGKILL');
          } catch {
            // best-effort
          }
        }
      }
      const info = await exitPromise.catch(() => ({ code: null, signal: null }));
      // If `everHealthy` is true (rare: a prior cycle was healthy and this
      // respawn just hung), treat as a runtime failure. Otherwise it's a
      // genuine startup failure — bad config, port-in-use, etc.
      const decision = shouldRespawn({
        everHealthy: state.everHealthy,
        respawnTimestamps: state.respawnTimestamps.filter((ts) => now() - ts < 60_000),
        now: now(),
      });
      if (!decision.respawn) {
        await onTerminalNonRespawn(decision.reason, info);
        deps.onTerminal?.(decision.reason);
        await cleanupPidFiles();
        return 1;
      }
      state.respawnTimestamps.push(now());
      const wait = nextBackoff(state.attempt);
      state.attempt += 1;
      await appendAuditSafe({
        source: 'watchdog-respawn',
        decision: 'allow',
        reason: 'health-timeout',
      });
      await emitRespawnNotif(state.respawnTimestamps.length, info);
      isRespawn = true;
      await sleep(wait);
      continue;
    }

    // healthy === 'ok' — daemon is running. Mark and arm stability timer.
    state.everHealthy = true;
    log(`daemon healthy after ${now() - spawnedAt}ms (pid=${child.pid})`);
    if (state.stabilityTimer) clearTimeout(state.stabilityTimer);
    state.stabilityTimer = setTimeout(() => {
      log('daemon stable ≥30s — resetting respawn counter');
      state.attempt = 0;
      state.respawnTimestamps = [];
      state.stabilityTimer = null;
    }, HEALTHY_STABILITY_MS);

    // Wait for the running daemon to exit (could be never, in which case
    // this resolves only when SIGTERM cascades through handleStopSignal).
    const info = await exitPromise;
    if (state.stabilityTimer) {
      clearTimeout(state.stabilityTimer);
      state.stabilityTimer = null;
    }
    if (stopping) break; // SIGTERM was the cause — exit cleanly.

    log(`daemon exited unexpectedly: code=${info.code} signal=${info.signal}`);
    const decision = shouldRespawn({
      everHealthy: state.everHealthy,
      respawnTimestamps: state.respawnTimestamps.filter((ts) => now() - ts < 60_000),
      now: now(),
    });
    if (!decision.respawn) {
      await onTerminalNonRespawn(decision.reason, info);
      deps.onTerminal?.(decision.reason);
      await cleanupPidFiles();
      return 1;
    }
    state.respawnTimestamps.push(now());
    const wait = nextBackoff(state.attempt);
    state.attempt += 1;
    await appendAuditSafe({
      source: 'watchdog-respawn',
      decision: 'allow',
      reason: describeExit(info),
    });
    await emitRespawnNotif(state.respawnTimestamps.length, info);
    isRespawn = true;
    log(`backoff ${wait}ms before respawn`);
    await sleep(wait);
  }

  await cleanupPidFiles();
  return 0;
}

// ----- helpers -----

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForChildExit(child: ChildProcess): Promise<ExitInfo> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

interface WaitForHealthyOpts {
  port: number;
  timeoutMs: number;
  pollIntervalMs: number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  exitPromise: Promise<ExitInfo>;
}

type HealthyResult = 'ok' | 'timeout' | 'exited-before-healthy';

async function waitForHealthy(opts: WaitForHealthyOpts): Promise<HealthyResult> {
  const deadline = opts.now() + opts.timeoutMs;
  let exited = false;
  void opts.exitPromise.then(() => {
    exited = true;
  });
  while (opts.now() < deadline) {
    if (exited) return 'exited-before-healthy';
    const ok = await pingHealth(opts.port, opts.fetchImpl);
    if (ok) return 'ok';
    await opts.sleep(opts.pollIntervalMs);
  }
  return 'timeout';
}

async function pingHealth(port: number, fetchImpl: typeof fetch): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_000);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/v1/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForExit(
  child: ChildProcess,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + graceMs;
  while (now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await sleep(50);
  }
  return false;
}

function describeExit(info: ExitInfo): string {
  if (info.signal) return `signal ${info.signal}`;
  if (info.code !== null) return `exit code ${info.code}`;
  return 'unknown exit';
}

function defaultDaemonEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'daemon', 'index.js');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLogger(deps: RunWatchdogDeps, logFile: string): (msg: string) => void {
  if (deps.silent) return () => {};
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
      fs.appendFileSync(logFile, line);
    } catch {
      // best-effort — surface to stderr too so detached startup capture sees it
    }
    process.stderr.write(`[watchdog] ${msg}\n`);
  };
}

async function unlinkBest(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch {
    // best-effort
  }
}

const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  runWatchdog()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`[watchdog] fatal: ${(e as Error).message}\n`);
      process.exit(1);
    });
}
