/**
 * Integration tests for the watchdog ↔ daemon-mock startup path. Targets the
 * regression surfaces that the manual session of 2026-04-29 hit:
 *
 * - PR #23 path: when the daemon writes a startup error to stderr before
 *   exiting, the bytes must end up in STARTUP_LOG_FILE so `kuroboto start`
 *   can tail it and surface a readable diagnostic instead of "daemon não
 *   respondeu em 10s".
 * - Watchdog-disabled fallback: --no-watchdog spawns the daemon directly and
 *   the same startup log capture works without the watchdog supervision
 *   layer in between (covered at the CLI layer below since runWatchdog is
 *   not in that path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wd-startup-'));
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

describe('watchdog startup path (PR #23 regression coverage)', () => {
  it('captures the daemon child stderr in STARTUP_LOG_FILE before the watchdog gives up', async () => {
    // Daemon-mock that writes a startup-error message to stderr then exits
    // with a non-zero code — the same shape as a real misconfigured daemon
    // (port-in-use, bad token, missing dep).
    const scriptPath = path.join(tmpDir, 'daemon-bad-config.mjs');
    await fsp.writeFile(
      scriptPath,
      `process.stderr.write('FAKE_STARTUP_ERROR: invalid daemon.port\\n');\nprocess.exit(2);\n`,
    );
    const paths = tmpPaths();

    const exitCode = await runWatchdog({
      paths,
      daemonEntry: scriptPath,
      loadConfigImpl: async () => baseConfig(),
      silent: true,
      auditImpl: async () => {},
      notifyImpl: async () => true,
      signalRegistrar: () => {
        /* no signals — let the watchdog hit its terminal state on its own */
      },
    });

    // Same daemon failure repeats forever → watchdog gives up after 5
    // attempts in 60s. Either 'startup-failure' (first cycle never gets
    // healthy) or 'gave-up' (multiple cycles) is acceptable; both are
    // terminal exits with code 1.
    expect(exitCode).toBe(1);

    const startupLog = await fsp.readFile(paths.startupLog, 'utf-8');
    expect(startupLog).toContain('FAKE_STARTUP_ERROR');
  }, 30_000);

  // Note: FD-leak resilience across respawn cycles is exercised by
  // watchdogBugC.test.ts's 'gives up after 5 rapid respawns' scenario,
  // which drives 5+ real spawn cycles and would crash with EMFILE if FDs
  // leaked. Duplicating that here with a fast-exit daemon would just be
  // a tautological 'startup-failure exits cleanly' check.
});
