import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { captureIO, stubFetch, jsonResponse, TEST_CONFIG } from '../../helpers/cliHarness.js';

function minimalStatusData() {
  return {
    daemon: { pid: 1, uptimeSec: 5, startedAt: new Date().toISOString(), hostname: 'test', port: 47891 },
    pending: { permissions: 0, notifications: 0, replies: 0 },
    mode: 'here',
    gaming: { active: false, until: null },
    sleeping: { active: [], capacity: 6 },
    injectClients: [],
    topics: { forumMode: false, count: 0 },
  };
}

let tmpDir: string;

vi.mock('../../../src/config/paths.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    PID_FILE: '__OVERRIDDEN_BY_BEFOREEACH__',
    WATCHDOG_PID_FILE: '__OVERRIDDEN_BY_BEFOREEACH__',
  };
});

vi.mock('../../../src/config/load.js', () => ({
  loadConfig: vi.fn(async () => TEST_CONFIG),
}));

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-status-'));
  const paths = await import('../../../src/config/paths.js');
  // @ts-expect-error overriding for tests
  paths.PID_FILE = path.join(tmpDir, 'daemon.pid');
  // @ts-expect-error overriding for tests
  paths.WATCHDOG_PID_FILE = path.join(tmpDir, 'watchdog.pid');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function spawnIdleNode(): { pid: number; close: () => void } {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);"],
    { stdio: 'ignore', windowsHide: true },
  );
  if (!child.pid) throw new Error('failed to spawn idle node');
  return {
    pid: child.pid,
    close: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
    },
  };
}

describe('cli/status — watchdog awareness', () => {
  it('shows both watchdog and daemon as alive when both PID files reference live procs', async () => {
    stubFetch(() => jsonResponse(minimalStatusData()));
    const io = captureIO();
    const watchdog = spawnIdleNode();
    const daemon = spawnIdleNode();
    try {
      const paths = await import('../../../src/config/paths.js');
      await fsp.writeFile(paths.WATCHDOG_PID_FILE, String(watchdog.pid));
      await fsp.writeFile(paths.PID_FILE, String(daemon.pid));

      const { statusCommand } = await import('../../../src/cli/status.js');
      await statusCommand();

      const out = io.out();
      expect(out).toMatch(new RegExp(`watchdog: alive \\(PID=${watchdog.pid}\\)`));
      expect(out).toMatch(new RegExp(`daemon: alive \\(PID=${daemon.pid}\\)`));
      expect(out).not.toContain('split-brain');
    } finally {
      watchdog.close();
      daemon.close();
    }
  });

  it('flags split-brain when the watchdog PID is stale but the daemon is alive', async () => {
    stubFetch(() => jsonResponse(minimalStatusData()));
    const io = captureIO();
    const daemon = spawnIdleNode();
    try {
      const paths = await import('../../../src/config/paths.js');
      // PID 1 on Unix / 0 on Windows is a problematic stand-in. Use a guaranteed-dead
      // PID by spawning one and reaping it.
      const dead = spawnIdleNode();
      dead.close();
      await new Promise((r) => setTimeout(r, 100));
      await fsp.writeFile(paths.WATCHDOG_PID_FILE, String(dead.pid));
      await fsp.writeFile(paths.PID_FILE, String(daemon.pid));

      const { statusCommand } = await import('../../../src/cli/status.js');
      await statusCommand();

      const out = io.out();
      expect(out).toContain('split-brain');
    } finally {
      daemon.close();
    }
  });

  it('shows daemon-only when no watchdog PID file exists (legacy / --no-watchdog)', async () => {
    stubFetch(() => jsonResponse(minimalStatusData()));
    const io = captureIO();
    const daemon = spawnIdleNode();
    try {
      const paths = await import('../../../src/config/paths.js');
      await fsp.writeFile(paths.PID_FILE, String(daemon.pid));

      const { statusCommand } = await import('../../../src/cli/status.js');
      await statusCommand();

      const out = io.out();
      expect(out).not.toContain('watchdog:');
      expect(out).toMatch(new RegExp(`daemon: alive \\(PID=${daemon.pid}\\)`));
      expect(out).not.toContain('split-brain');
    } finally {
      daemon.close();
    }
  });
});
