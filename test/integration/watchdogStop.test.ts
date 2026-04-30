/**
 * Integration tests for the watchdog SIGTERM / SIGKILL path. Verifies that
 * `kuroboto stop` (which sends SIGTERM to the watchdog PID) results in:
 *
 * - The daemon child being terminated cleanly when it honors SIGTERM.
 * - SIGKILL escalation when the daemon ignores SIGTERM beyond the grace
 *   window (STOP_GRACE_MS = 5s).
 * - Both PID files removed on watchdog exit.
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
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wd-stop-'));
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

function mockDaemonScript(port: number, opts: { ignoreSigterm?: boolean } = {}): string {
  const sigtermBody = opts.ignoreSigterm
    ? `// Intentionally ignore SIGTERM — exercises the SIGKILL escalation path.
       process.on('SIGTERM', () => {});`
    : `process.on('SIGTERM', () => process.exit(0));`;
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
server.listen(${port}, '127.0.0.1');
${sigtermBody}
setInterval(() => {}, 60_000);
`;
}

describe('watchdog stop path (SIGTERM / SIGKILL escalation + PID file cleanup)', () => {
  it('SIGTERM kills the daemon and removes both PID files', async () => {
    const scriptPath = path.join(tmpDir, 'daemon-mock.mjs');
    await fsp.writeFile(scriptPath, mockDaemonScript(chosenPort));
    const paths = tmpPaths();

    let signalHandler: ((sig: NodeJS.Signals) => void) | null = null;
    const completed = runWatchdog({
      paths,
      daemonEntry: scriptPath,
      loadConfigImpl: async () => baseConfig(),
      silent: true,
      auditImpl: async () => {},
      notifyImpl: async () => true,
      signalRegistrar: (h) => {
        signalHandler = h;
      },
    });

    await waitForFile(paths.pidFile, 8_000);
    expect(fs.existsSync(paths.pidFile)).toBe(true);

    // Trigger the stop — same path that `kuroboto stop` exercises in production.
    signalHandler?.('SIGTERM');
    const exitCode = await completed;

    expect(exitCode).toBe(0);
    expect(fs.existsSync(paths.pidFile)).toBe(false);
    expect(fs.existsSync(paths.daemonPidFile)).toBe(false);
  }, 15_000);

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when the daemon ignores SIGTERM beyond the grace window',
    async () => {
      // This test only runs on POSIX. On Windows, child.kill('SIGTERM') is
      // already a forceful termination — there is no signal handler in the
      // child to honor or ignore, so the SIGKILL escalation branch is dead
      // code there. Verifying the grace-then-escalate path requires a real
      // signal-aware runtime.
      const scriptPath = path.join(tmpDir, 'daemon-ignores-sigterm.mjs');
      await fsp.writeFile(scriptPath, mockDaemonScript(chosenPort, { ignoreSigterm: true }));
      const paths = tmpPaths();

      let signalHandler: ((sig: NodeJS.Signals) => void) | null = null;
      const completed = runWatchdog({
        paths,
        daemonEntry: scriptPath,
        loadConfigImpl: async () => baseConfig(),
        silent: true,
        auditImpl: async () => {},
        notifyImpl: async () => true,
        signalRegistrar: (h) => {
          signalHandler = h;
        },
      });

      // Wait until /health returns 200 — only after that does the daemon-mock's
      // SIGTERM handler exist. Sending SIGTERM before then races with Node's
      // default SIGTERM behaviour and exits the child before the ignore handler
      // is registered.
      await waitForFile(paths.pidFile, 8_000);
      await waitForHealth(chosenPort, 8_000);

      const sigtermAt = Date.now();
      signalHandler?.('SIGTERM');
      const exitCode = await completed;
      const elapsed = Date.now() - sigtermAt;

      // Grace window is STOP_GRACE_MS = 5s.
      expect(exitCode).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(10_000);
      expect(fs.existsSync(paths.pidFile)).toBe(false);
    },
    20_000,
  );
});

async function waitForHealth(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon /health did not respond within ${ms}ms`);
}

async function waitForFile(file: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`file ${file} did not appear within ${ms}ms`);
}
