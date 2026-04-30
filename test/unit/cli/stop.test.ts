import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { captureIO } from '../../helpers/cliHarness.js';

let tmpDir: string;

vi.mock('../../../src/config/paths.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    PID_FILE: '__OVERRIDDEN_BY_BEFOREEACH__',
    WATCHDOG_PID_FILE: '__OVERRIDDEN_BY_BEFOREEACH__',
  };
});

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-stop-'));
  // Re-stub the constants per-test so each test gets a fresh tmp path.
  const paths = await import('../../../src/config/paths.js');
  // @ts-expect-error overriding for tests
  paths.PID_FILE = path.join(tmpDir, 'daemon.pid');
  // @ts-expect-error overriding for tests
  paths.WATCHDOG_PID_FILE = path.join(tmpDir, 'watchdog.pid');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Spawn a node process that lives until SIGTERM, returning its PID. */
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

describe('cli/stop — watchdog-aware routing', () => {
  it('SIGTERMs the watchdog when its PID file is present (priority over daemon PID)', async () => {
    const io = captureIO();
    const watchdog = spawnIdleNode();
    const daemon = spawnIdleNode();
    try {
      const paths = await import('../../../src/config/paths.js');
      await fsp.writeFile(paths.WATCHDOG_PID_FILE, String(watchdog.pid));
      await fsp.writeFile(paths.PID_FILE, String(daemon.pid));

      const { stopCommand } = await import('../../../src/cli/stop.js');
      await stopCommand();

      // Watchdog should be killed; daemon was untouched (real watchdog would
      // cascade-kill it, but this test substitutes a no-op idle process).
      await waitForExit(watchdog.pid, 5_000);
      expect(io.out()).toContain('watchdog + daemon parados');
    } finally {
      watchdog.close();
      daemon.close();
    }
  });

  it('falls back to the legacy direct-daemon kill when no watchdog PID file exists', async () => {
    const io = captureIO();
    const daemon = spawnIdleNode();
    try {
      const paths = await import('../../../src/config/paths.js');
      await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
      // No watchdog PID file → take the legacy path.

      const { stopCommand } = await import('../../../src/cli/stop.js');
      await stopCommand();

      await waitForExit(daemon.pid, 5_000);
      expect(io.out()).toContain('daemon parado');
    } finally {
      daemon.close();
    }
  });

  it('reports cleanly when neither PID file exists', async () => {
    const io = captureIO();
    const { stopCommand } = await import('../../../src/cli/stop.js');
    await stopCommand();
    expect(io.out()).toContain('nenhum daemon rodando');
  });
});

async function waitForExit(pid: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} still alive after ${ms}ms`);
}
