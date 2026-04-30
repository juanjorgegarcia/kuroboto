import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runWatchdog } from '../../../src/watchdog/index.js';

/**
 * A controllable fake ChildProcess. Tests can call `simulateExit(...)` to
 * trigger the same `'exit'` event the watchdog reacts to.
 */
class FakeChild extends EventEmitter {
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public killed = false;
  public stdin = null;
  public stdout = null;
  public stderr = null;
  public killCalls: Array<NodeJS.Signals | undefined> = [];
  constructor(public pid: number) {
    super();
  }
  kill(sig?: NodeJS.Signals): boolean {
    this.killCalls.push(sig);
    this.killed = true;
    // Simulate immediate cooperative exit on SIGTERM unless test
    // overrides via .ignoreSignals = true
    if (sig === 'SIGTERM' && !this.ignoreSignals) {
      queueMicrotask(() => this.simulateExit(0, sig));
    }
    return true;
  }
  ignoreSignals = false;
  simulateExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface SpawnedRecord {
  child: FakeChild;
  args: string[];
  opts: SpawnOptions;
}

interface HarnessOpts {
  /** Stage 'ok' → /health returns 200; 'fail' → never 200. Tests can mutate per cycle. */
  healthBehavior?: 'ok' | 'fail';
}

function makeHarness(opts: HarnessOpts = {}) {
  const spawned: SpawnedRecord[] = [];
  let healthBehavior = opts.healthBehavior ?? 'ok';
  let nextPid = 10_000;

  const fakeSpawn = (
    _cmd: string,
    args: string[],
    spawnOpts: SpawnOptions,
  ): ChildProcess => {
    const child = new FakeChild(nextPid++);
    spawned.push({ child, args, opts: spawnOpts });
    return child as unknown as ChildProcess;
  };

  const fakeFetch: typeof fetch = async () => {
    if (healthBehavior === 'ok') {
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('econnrefused');
  };

  const audits: Array<{ source: string; decision: string; reason: string }> = [];
  const notifs: string[] = [];
  const terminalEvents: string[] = [];
  const respawnPids: Array<number | undefined> = [];
  let signalHandler: ((sig: NodeJS.Signals) => void) | null = null;

  const sleeps: number[] = [];
  // Skip real waits but keep ordering — use queueMicrotask so async control
  // flow still yields between operations.
  const fakeSleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return new Promise((r) => queueMicrotask(r));
  };

  const setHealth = (b: 'ok' | 'fail') => {
    healthBehavior = b;
  };

  return {
    spawned,
    audits,
    notifs,
    terminalEvents,
    respawnPids,
    sleeps,
    setHealth,
    triggerSignal: (sig: NodeJS.Signals) => signalHandler?.(sig),
    deps: {
      spawn: fakeSpawn,
      fetchImpl: fakeFetch,
      sleep: fakeSleep,
      silent: true,
      auditImpl: async (e: { source: string; decision: 'allow' | 'deny'; reason: string }) => {
        audits.push(e);
      },
      notifyImpl: async (text: string) => {
        notifs.push(text);
        return true;
      },
      onTerminal: (r: 'startup-failure' | 'gave-up' | 'sigterm') => {
        terminalEvents.push(r);
      },
      onDaemonRespawn: (pid: number | undefined) => {
        respawnPids.push(pid);
      },
      signalRegistrar: (handler: (sig: NodeJS.Signals) => void) => {
        signalHandler = handler;
      },
    },
  };
}

const baseConfig = {
  channel: { token: 't', chatId: 1, forumMode: false },
  daemon: { port: 47891 },
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'watchdog-test-'));
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

describe('runWatchdog — startup failure (everHealthy === false)', () => {
  it('does not respawn when /health never 200s on the first cycle — exits non-zero', async () => {
    const h = makeHarness({ healthBehavior: 'fail' });

    // Drive the timeout: as the watchdog polls /health, advance fake clock
    // past the 10s deadline by overriding `now`. We don't use real time.
    let t = 0;
    const now = () => {
      t += 600; // each tick advances 600ms — with 10s deadline this exits ~17 polls in
      return t;
    };

    const exitCode = await runWatchdog({
      ...h.deps,
      now,
      paths: tmpPaths(),
      loadConfigImpl: async () => baseConfig,
      daemonEntry: '/fake/daemon.js',
    });

    expect(exitCode).toBe(1);
    expect(h.terminalEvents).toContain('startup-failure');
    // Audit + notif paint the user-visible error path.
    expect(h.audits.some((a) => a.source === 'watchdog-startup-failure')).toBe(true);
    expect(h.notifs.some((n) => n.includes('investigar config'))).toBe(true);
  });
});

describe('runWatchdog — runtime crash (Bug C path)', () => {
  it('respawns the daemon after a runtime exit and restores health', async () => {
    const h = makeHarness({ healthBehavior: 'ok' });
    let t = 0;
    const now = () => {
      // advance just enough each call so health polls don't time out
      t += 50;
      return t;
    };

    // After the first daemon becomes healthy, kill it externally.
    setTimeout(() => {
      const first = h.spawned[0]?.child;
      if (first) first.simulateExit(null, 'SIGKILL');
    }, 30);
    // After the second daemon comes up, signal SIGTERM to break the loop.
    setTimeout(() => h.triggerSignal('SIGTERM'), 100);

    await runWatchdog({
      ...h.deps,
      now,
      paths: tmpPaths(),
      loadConfigImpl: async () => baseConfig,
      daemonEntry: '/fake/daemon.js',
    });

    expect(h.spawned.length).toBeGreaterThanOrEqual(2);
    expect(h.audits.some((a) => a.source === 'watchdog-respawn')).toBe(true);
    expect(h.notifs.some((n) => n.includes('respawnado'))).toBe(true);
    // SIGTERM cascade kills the second daemon.
    expect(h.terminalEvents).toContain('sigterm');
  });
});

describe('runWatchdog — gave-up after rapid burst', () => {
  it('stops respawning after 5 failures inside the 60s window', async () => {
    const h = makeHarness({ healthBehavior: 'ok' });

    // Make every spawned daemon "go healthy then crash 1ms later" by
    // hooking into spawn to wire up a quick exit.
    const realSpawn = h.deps.spawn;
    const wrappedSpawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
      const child = realSpawn(cmd, args, opts) as unknown as FakeChild;
      // Crash shortly after becoming healthy. The harness's `now` advances
      // synthetically; we trigger via setTimeout so the loop has a turn.
      setTimeout(() => child.simulateExit(1, null), 5);
      return child as unknown as ChildProcess;
    };

    let t = 0;
    const now = () => {
      // Advance time slowly so all 5 respawns fall inside the 60s window.
      t += 100;
      return t;
    };

    const exitCode = await runWatchdog({
      ...h.deps,
      spawn: wrappedSpawn,
      now,
      paths: tmpPaths(),
      loadConfigImpl: async () => baseConfig,
      daemonEntry: '/fake/daemon.js',
    });

    expect(exitCode).toBe(1);
    expect(h.terminalEvents).toContain('gave-up');
    expect(h.audits.some((a) => a.source === 'watchdog-gave-up')).toBe(true);
    expect(h.notifs.some((n) => n.includes('watchdog deu up'))).toBe(true);
  });
});

describe('runWatchdog — clean SIGTERM shutdown', () => {
  it('kills the daemon child on SIGTERM and removes both PID files', async () => {
    const h = makeHarness({ healthBehavior: 'ok' });
    let t = 0;
    const now = () => {
      t += 50;
      return t;
    };

    // Trigger SIGTERM after the first daemon becomes healthy.
    setTimeout(() => h.triggerSignal('SIGTERM'), 50);

    const paths = tmpPaths();
    // Pre-create the daemon PID file so cleanup has something to unlink.
    await fsp.writeFile(paths.daemonPidFile, '12345');

    await runWatchdog({
      ...h.deps,
      now,
      paths,
      loadConfigImpl: async () => baseConfig,
      daemonEntry: '/fake/daemon.js',
    });

    expect(h.terminalEvents).toContain('sigterm');
    // Both PID files are gone after clean shutdown.
    await expect(fsp.access(paths.pidFile)).rejects.toThrow();
    await expect(fsp.access(paths.daemonPidFile)).rejects.toThrow();
    // SIGTERM was forwarded to the child first.
    const firstChild = h.spawned[0].child;
    expect(firstChild.killCalls).toContain('SIGTERM');
  });
});

describe('runWatchdog — PID file lifecycle', () => {
  it('writes the watchdog PID file at startup and removes it on terminal exit', async () => {
    const h = makeHarness({ healthBehavior: 'fail' });
    const paths = tmpPaths();

    let t = 0;
    const now = () => {
      t += 600;
      return t;
    };

    await runWatchdog({
      ...h.deps,
      now,
      paths,
      loadConfigImpl: async () => baseConfig,
      daemonEntry: '/fake/daemon.js',
    });

    // After give-up, PID file is removed.
    await expect(fsp.access(paths.pidFile)).rejects.toThrow();
  });
});
