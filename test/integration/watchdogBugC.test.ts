/**
 * Integration test for the watchdog process running against a real Node child
 * process — the closest practical anti-regression for Bug C from the
 * 2026-04-29 sessions, where the daemon would die silently and stay dead until
 * the user noticed and ran `kuroboto ohayo`.
 *
 * The "daemon mock" is a tiny inline Node script that opens an HTTP server on
 * the configured port and answers `/v1/health`. We then SIGKILL it and assert
 * the watchdog's `child.on('exit')` listener fires and respawns it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runWatchdog } from '../../src/watchdog/index.js';

let tmpDir: string;
let chosenPort: number;

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('no addr'));
      }
    });
    server.on('error', reject);
  });
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wd-bugc-'));
  chosenPort = await pickPort();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function tmpPaths() {
  return {
    pidFile: path.join(tmpDir, 'watchdog.pid'),
    daemonPidFile: path.join(tmpDir, 'daemon.pid'),
    logFile: path.join(tmpDir, 'watchdog.log'),
    startupLog: path.join(tmpDir, 'startup.log'),
  };
}

const baseConfig = () => ({
  channel: { token: 'x', chatId: 1, forumMode: false },
  daemon: { port: chosenPort },
});

/** Body of the daemon-mock script, written to a tmp .mjs file per-test. */
function mockDaemonScript(opts: { port: number; exitAfterMs?: number; exitCode?: number }): string {
  return `
import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.url === '/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptimeSec: 1, pending: 0 }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(${opts.port}, '127.0.0.1');
${opts.exitAfterMs !== undefined ? `setTimeout(() => process.exit(${opts.exitCode ?? 1}), ${opts.exitAfterMs});` : ''}
`;
}

describe('watchdog ↔ real daemon child (Bug C anti-regression)', () => {
  it('respawns after the daemon child exits — the bug-C path', async () => {
    // Daemon-mock: serves /health, then exits with code 1 after 800ms,
    // simulating an unhealthy process death (our real signal-driven kill
    // behaves identically from the watchdog's POV).
    const scriptPath = path.join(tmpDir, 'daemon-mock.mjs');
    await fsp.writeFile(scriptPath, mockDaemonScript({ port: chosenPort, exitAfterMs: 800, exitCode: 1 }));

    const respawnPids: Array<number | undefined> = [];
    let terminalReason: string | null = null;

    // Run the watchdog with a deadline — if it doesn't terminate on its own
    // we trigger SIGTERM after the second respawn or after 8 seconds.
    const completed = runWatchdog({
      paths: tmpPaths(),
      daemonEntry: scriptPath,
      loadConfigImpl: async () => baseConfig(),
      silent: true,
      auditImpl: async () => {},
      notifyImpl: async () => true,
      onDaemonRespawn: (pid) => {
        respawnPids.push(pid);
      },
      onTerminal: (r) => {
        terminalReason = r;
      },
      // Inject a no-op signalRegistrar so we can trigger SIGTERM ourselves.
      signalRegistrar: (h) => {
        signalHandler = h;
      },
    });

    let signalHandler: ((sig: NodeJS.Signals) => void) | null = null;

    // Wait for at least one respawn or 8s — whichever comes first.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && respawnPids.length < 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Trigger SIGTERM to break the loop cleanly.
    signalHandler?.('SIGTERM');
    await completed;

    expect(respawnPids.length).toBeGreaterThanOrEqual(1);
    expect(terminalReason).toBe('sigterm');
  }, 15_000);

  it('respawns after a JS crash with crashHandlers also firing (PR #26 cross-coverage)', async () => {
    // Simulate the PR #26 integration: installCrashHandlers writes the
    // daemon.crash.log on uncaught exception, AND the watchdog observes the
    // child exit and respawns. This verifies both halves of the bug-C defense
    // run together.
    const crashLogFile = path.join(tmpDir, 'daemon.crash.log');
    // Daemon-mock: starts /health server, then 1.2s later throws an uncaught
    // exception. Inline-replicates installCrashHandlers' write path so we
    // don't pull in TS sources from a tmp .mjs file.
    const scriptPath = path.join(tmpDir, 'daemon-crash.mjs');
    await fsp.writeFile(
      scriptPath,
      `
import http from 'node:http';
import fs from 'node:fs';
process.on('uncaughtException', (e) => {
  fs.writeFileSync(${JSON.stringify(crashLogFile)}, JSON.stringify({ ts: new Date().toISOString(), kind: 'uncaughtException', message: e.message, stack: e.stack }) + '\\n');
  process.exit(1);
});
const server = http.createServer((req, res) => {
  if (req.url === '/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptimeSec: 1, pending: 0 }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(${chosenPort}, '127.0.0.1');
setTimeout(() => { throw new Error('SIMULATED_DAEMON_CRASH'); }, 1200);
`,
    );

    const respawnPids: Array<number | undefined> = [];
    let signalHandler: ((sig: NodeJS.Signals) => void) | null = null;

    const completed = runWatchdog({
      paths: tmpPaths(),
      daemonEntry: scriptPath,
      loadConfigImpl: async () => baseConfig(),
      silent: true,
      auditImpl: async () => {},
      notifyImpl: async () => true,
      onDaemonRespawn: (pid) => respawnPids.push(pid),
      signalRegistrar: (h) => {
        signalHandler = h;
      },
    });

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && respawnPids.length < 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    signalHandler?.('SIGTERM');
    await completed;

    // Watchdog observed the crash and respawned.
    expect(respawnPids.length).toBeGreaterThanOrEqual(1);
    // The PR #26 crashHandlers wrote the crash log before exiting.
    expect(fs.existsSync(crashLogFile)).toBe(true);
    const crashEntry = JSON.parse(fs.readFileSync(crashLogFile, 'utf-8').trim());
    expect(crashEntry.kind).toBe('uncaughtException');
    expect(crashEntry.message).toContain('SIMULATED_DAEMON_CRASH');
  }, 20_000);

  it('gives up after 5 rapid respawns in 60s and emits gave-up notif', async () => {
    // Daemon-mock that briefly serves /health (so everHealthy flips true),
    // then exits — forces the watchdog into the runtime-crash respawn path
    // repeatedly. Default policy budget is 5 respawns in a 60s window; the
    // 6th attempt should be refused and onTerminal('gave-up') fires.
    // exitAfterMs needs comfortable margin above HEALTH_POLL_INTERVAL_MS
    // (250ms) plus listen()+first round-trip time. 600ms was tight enough
    // that macOS CI runners flaked: the first cycle occasionally exited
    // before everHealthy flipped true, dropping into 'startup-failure'
    // instead of the 'gave-up' path this test exercises. 1200ms gives
    // ~4 health probes per cycle.
    const scriptPath = path.join(tmpDir, 'daemon-flapping.mjs');
    await fsp.writeFile(
      scriptPath,
      mockDaemonScript({ port: chosenPort, exitAfterMs: 1200, exitCode: 1 }),
    );

    // Inject a fast sleep that immediately resolves — backoff ladder is
    // 1+2+4+8+16=31s of real waits which would be cripplingly slow in a
    // test. The 60s window check uses Date.now(), but since each respawn
    // also takes the daemon's exitAfterMs (~1200ms) of real time, the
    // window has plenty of room for the 5+ respawns.
    let terminalReason: string | null = null;
    const respawnPids: Array<number | undefined> = [];
    const exitCode = await runWatchdog({
      paths: tmpPaths(),
      daemonEntry: scriptPath,
      loadConfigImpl: async () => baseConfig(),
      silent: true,
      sleep: async () => {},
      auditImpl: async () => {},
      notifyImpl: async () => true,
      onDaemonRespawn: (pid) => respawnPids.push(pid),
      onTerminal: (r) => {
        terminalReason = r;
      },
      signalRegistrar: () => {
        /* no signals — let the watchdog hit its policy cap on its own */
      },
    });

    expect(exitCode).toBe(1);
    expect(terminalReason).toBe('gave-up');
    // Hook fires from iteration 2 onwards; with budget 5 the loop runs
    // ≥5 times before giving up, so we should have observed multiple
    // respawn callbacks. Lower-bound 4 to stay tolerant of timing jitter.
    expect(respawnPids.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('does NOT respawn when the daemon never reaches healthy (avoids infinite loop on bad config)', async () => {
    // Daemon-mock that exits immediately on startup.
    const scriptPath = path.join(tmpDir, 'daemon-fails-fast.mjs');
    await fsp.writeFile(scriptPath, `process.exit(1);`);

    const respawnPids: Array<number | undefined> = [];
    let terminalReason: string | null = null;

    const exitCode = await runWatchdog({
      paths: tmpPaths(),
      daemonEntry: scriptPath,
      loadConfigImpl: async () => baseConfig(),
      silent: true,
      auditImpl: async () => {},
      notifyImpl: async () => true,
      onDaemonRespawn: (pid) => {
        respawnPids.push(pid);
      },
      onTerminal: (r) => {
        terminalReason = r;
      },
      signalRegistrar: () => {
        /* no-op — we don't need to send signals here */
      },
    });

    expect(exitCode).toBe(1);
    expect(terminalReason).toBe('startup-failure');
    // No respawns — startup failure short-circuits.
    expect(respawnPids.length).toBe(0);
  }, 15_000);
});
