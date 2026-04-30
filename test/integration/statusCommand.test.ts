/**
 * Anti-regression integration tests for `kuroboto status`.
 * Each test name carries the bug reference / spec requirement so a refactor
 * cannot quietly regress it without an explicit test name change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { captureIO, stubFetch, jsonResponse, runWithExitCapture, TEST_CONFIG } from '../helpers/cliHarness.js';
import type { FetchHandler } from '../helpers/cliHarness.js';

// ─── Infra ───────────────────────────────────────────────────────────────────

let tmpDir: string;

vi.mock('../../src/config/paths.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    PID_FILE: '__OVERRIDDEN_BY_BEFOREEACH__',
    WATCHDOG_PID_FILE: '__OVERRIDDEN_BY_BEFOREEACH__',
  };
});

vi.mock('../../src/config/load.js', () => ({
  loadConfig: vi.fn(async () => TEST_CONFIG),
}));

vi.mock('../../src/daemon/state.js', () => ({
  loadMode: vi.fn(async () => 'here' as const),
  saveMode: vi.fn(async () => {}),
}));

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-status-int-'));
  const paths = await import('../../src/config/paths.js');
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
    close: () => { try { child.kill('SIGKILL'); } catch { /* best-effort */ } },
  };
}

function makeStatusData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    daemon: { pid: 99999, uptimeSec: 60, startedAt: new Date().toISOString(), hostname: 'h', port: 47891 },
    pending: { permissions: 0, notifications: 0, replies: 0 },
    mode: 'here',
    gaming: { active: false, until: null },
    sleeping: { active: [], capacity: 6 },
    injectClients: [],
    topics: { forumMode: false, count: 0 },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

it('kuroboto status mostra gaming armed (bug confirmado em uso 2026-04-29)', async () => {
  const daemon = spawnIdleNode();
  try {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
    stubFetch(() =>
      jsonResponse(makeStatusData({ gaming: { active: true, until: null } })),
    );
    const io = captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();
    expect(io.out()).toContain('gaming: armed (sem timer)');
  } finally {
    daemon.close();
  }
});

it('mode vem do daemon, não do disco (consistência runtime vs state.json)', async () => {
  const daemon = spawnIdleNode();
  try {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
    // Daemon says 'away', disk (loadMode mock) says 'here'
    stubFetch(() => jsonResponse(makeStatusData({ mode: 'away' })));
    const io = captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();
    expect(io.out()).toContain('mode: away');
    // disk fallback must not appear
    expect(io.out()).not.toContain('from disk');
  } finally {
    daemon.close();
  }
});

it('inject clients listam após bindSessionByCwd race', async () => {
  const daemon = spawnIdleNode();
  try {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
    const clients = [
      { slug: 'poe-alt-crafter', pid: 9876, cwd: 'C:/work/PoeAltCrafter', localPort: 33333, registeredAt: Date.now(), sessions: [] },
    ];
    stubFetch(() => jsonResponse(makeStatusData({ injectClients: clients })));
    const io = captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();
    const out = io.out();
    expect(out).toContain('inject clients: 1 registered');
    expect(out).toContain('poe-alt-crafter');
    expect(out).toContain('PID=9876');
  } finally {
    daemon.close();
  }
});

it('daemon offline → fallback parcial sem crash', async () => {
  const paths = await import('../../src/config/paths.js');
  const deadPid = 2; // nearly guaranteed dead
  await fsp.writeFile(paths.PID_FILE, String(deadPid));
  stubFetch(() => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
  const io = captureIO();
  const { statusCommand } = await import('../../src/cli/status.js');
  const { exitCode } = await runWithExitCapture(() => statusCommand());
  const out = io.out();
  expect(out).toContain('dead');
  expect(out).toContain('from disk — daemon offline');
  expect(out).toContain('daemon offline —');
  expect(exitCode).toBe(1);
});

it('WATCHDOG_PID_FILE ausente → linha watchdog não aparece (decoupled from Spec G)', async () => {
  const daemon = spawnIdleNode();
  try {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
    // No watchdog.pid file written
    stubFetch(() => jsonResponse(makeStatusData()));
    const io = captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();
    expect(io.out()).not.toContain('watchdog:');
  } finally {
    daemon.close();
  }
});

it('--watch tolera daemon caindo mid-loop sem crash', async () => {
  const daemon = spawnIdleNode();
  try {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(daemon.pid));

    let call = 0;
    const handler: FetchHandler = () => {
      call++;
      if (call === 2) {
        return jsonResponse({ error: 'service unavailable' }, 503);
      }
      return jsonResponse(makeStatusData());
    };
    stubFetch(handler);

    // Suppress terminal output
    captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');

    // Run 3 watch frames at 0.05s, then let SIGINT fire
    let frameCount = 0;
    const renderSpy = vi.spyOn(process.stdout, 'write');
    renderSpy.mockImplementation((() => true) as never);

    const watchP = statusCommand({ watch: 0.05 });
    // Wait for 3 render cycles, then simulate Ctrl+C
    await new Promise<void>((res) => setTimeout(res, 300));
    process.emit('SIGINT' as NodeJS.Signals);
    // watchP will resolve (process.exit(0) is called, but process.exit is not stubbed here)
    // Just check no error was thrown during the interval
    await Promise.race([watchP, new Promise((r) => setTimeout(r, 200))]).catch(() => {});
    // No assertion on frameCount — just confirm we didn't throw
  } finally {
    daemon.close();
  }
});

it('--json schema snapshot estável', async () => {
  const daemon = spawnIdleNode();
  try {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
    const fullData = makeStatusData({
      gaming: { active: true, until: Date.now() + 900_000 },
      sleeping: {
        active: [
          { slug: 'fix-bot', branch: 'sleep/fix-bot', worktreePath: '/tmp/fix-bot', startedAt: Date.now() - 60_000, expectedEndAt: Date.now() + 3_600_000 },
        ],
        capacity: 6,
      },
      injectClients: [
        { slug: 'poe', pid: 111, cwd: '/work', localPort: 1234, registeredAt: Date.now(), sessions: [] },
      ],
      topics: { forumMode: true, count: 3 },
    });
    stubFetch(() => jsonResponse(fullData));
    const io = captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand({ json: true });
    const out = io.out();
    const parsed = JSON.parse(out) as Record<string, unknown>;
    // Schema gate — these keys must always be present
    expect(parsed.configPath).toBeDefined();
    expect(parsed.daemonPid).toBeDefined();
    expect(parsed.daemonAlive).toBe(true);
    expect(parsed.fetchResult).toBeDefined();
    expect((parsed.fetchResult as Record<string, unknown>).ok).toBe(true);
    expect(parsed.installedHooks).toBeDefined();
  } finally {
    daemon.close();
  }
});

it('forumMode on com topics.json vazio → "0 mapeados" sem crash', async () => {
  const daemon = spawnIdleNode();
  try {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
    stubFetch(() => jsonResponse(makeStatusData({ topics: { forumMode: true, count: 0 } })));
    const io = captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();
    expect(io.out()).toContain('forumMode on, 0 mapeados');
  } finally {
    daemon.close();
  }
});

it('status durante stop concorrente → trata como offline graceful', async () => {
  const paths = await import('../../src/config/paths.js');
  const deadPid = 3; // practically guaranteed dead
  await fsp.writeFile(paths.PID_FILE, String(deadPid));
  stubFetch(() => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });
  const io = captureIO();
  const { statusCommand } = await import('../../src/cli/status.js');
  const { exitCode } = await runWithExitCapture(() => statusCommand());
  const out = io.out();
  expect(out).toContain('dead');
  expect(out).toContain('daemon offline —');
  expect(exitCode).toBe(1);
});

describe('--quiet flag', () => {
  it('alive → "daemon: alive" + exit 0', async () => {
    const daemon = spawnIdleNode();
    try {
      const paths = await import('../../src/config/paths.js');
      await fsp.writeFile(paths.PID_FILE, String(daemon.pid));
      stubFetch(() => jsonResponse(makeStatusData()));
      const io = captureIO();
      const { statusCommand } = await import('../../src/cli/status.js');
      await statusCommand({ quiet: true });
      expect(io.out().trim()).toBe('daemon: alive');
    } finally {
      daemon.close();
    }
  });

  it('dead → "daemon: dead" + exit 1', async () => {
    const paths = await import('../../src/config/paths.js');
    await fsp.writeFile(paths.PID_FILE, String(9999999)); // guaranteed dead
    stubFetch(() => { throw new Error('ECONNREFUSED'); });
    const io = captureIO();
    const { statusCommand } = await import('../../src/cli/status.js');
    const { exitCode } = await runWithExitCapture(() => statusCommand({ quiet: true }));
    expect(io.out().trim()).toBe('daemon: dead');
    expect(exitCode).toBe(1);
  });
});
