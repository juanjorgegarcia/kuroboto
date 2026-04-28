import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SleepingOrchestrator, type SleepingDeps, type SpawnFn } from '../../src/daemon/sleeping.js';
import { GamingState } from '../../src/daemon/gaming.js';

class FakeChild extends EventEmitter {
  killed = false;
  pid = 12345;
  kill(_sig?: NodeJS.Signals) {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

interface DepsState {
  child?: FakeChild;
  notifications: string[];
  audits: unknown[];
  worktreeCreated?: { repo: string; branch: string; dir: string };
  worktreeRemoved: string[];
}

function makeDeps(): { deps: SleepingDeps; state: DepsState } {
  const state: DepsState = { notifications: [], audits: [], worktreeRemoved: [] };
  const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
    state.child = new FakeChild();
    return state.child as unknown as ReturnType<SpawnFn>;
  };
  const deps: SleepingDeps = {
    spawn: spawnFn,
    gaming: new GamingState(),
    notify: async (msg) => { state.notifications.push(msg); },
    audit: async (e) => { state.audits.push(e); },
    createWorktree: async (repo, branch, dir) => {
      state.worktreeCreated = { repo, branch, dir };
    },
    removeWorktree: async (_repo, dir) => {
      state.worktreeRemoved.push(dir);
    },
    onSuccess: vi.fn(async (_session) => {}),
  };
  return { deps, state };
}

describe('SleepingOrchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial: idle snapshot', () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    expect(orch.snapshot()).toEqual({ active: false });
  });

  it('start creates worktree, arms gaming, spawns child, returns session', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const session = await orch.start({
      repo: '/x/repo',
      prompt: 'implement billing flow',
      workRoot: '/y/wt',
      maxDurationMs: 60_000,
    });
    expect(session.slug).toMatch(/^implement-billing-flow-[a-z0-9]{6}$/);
    expect(session.branch).toMatch(/^sleep\/implement-billing-flow-[a-z0-9]{6}$/);
    expect(state.worktreeCreated).toEqual({
      repo: '/x/repo',
      branch: session.branch,
      dir: `/y/wt/${session.slug}`,
    });
    expect(deps.gaming.snapshot().active).toBe(true);
    expect(state.child).toBeDefined();
    const snap = orch.snapshot();
    expect(snap.active).toBe(true);
    if (snap.active) expect(snap.slug).toMatch(/^implement-billing-flow-[a-z0-9]{6}$/);
  });

  it('rejects start when one is already active', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    await expect(
      orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 }),
    ).rejects.toThrow(/already/);
  });

  it('child exit 0 → onSuccess called, gaming restored, state idle', async () => {
    const { deps, state } = makeDeps();
    const gaming = deps.gaming;
    const orch = new SleepingOrchestrator(deps);
    expect(gaming.snapshot().active).toBe(false);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    expect(gaming.snapshot().active).toBe(true);
    state.child!.emit('exit', 0, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.onSuccess).toHaveBeenCalledTimes(1);
    expect(gaming.snapshot().active).toBe(false);
    expect(orch.snapshot().active).toBe(false);
  });

  it('child exit non-zero → failure notification, gaming restored, state idle', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    state.child!.emit('exit', 1, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.notifications.some((n) => n.includes('failed'))).toBe(true);
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.gaming.snapshot().active).toBe(false);
    expect(orch.snapshot().active).toBe(false);
  });

  it('max duration timer kills child, sends timeout notification', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 50 });
    expect(state.child!.killed).toBe(false);
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.child!.killed).toBe(true);
    expect(state.notifications.some((n) => n.includes('timed out') || n.includes('timeout'))).toBe(true);
    expect(orch.snapshot().active).toBe(false);
  });

  it('cancel() kills child, sends cancelled notification, state idle', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    await orch.cancel();
    expect(state.child!.killed).toBe(true);
    expect(state.notifications.some((n) => n.toLowerCase().includes('cancel'))).toBe(true);
    expect(orch.snapshot().active).toBe(false);
  });

  it('cancel() is no-op when idle', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const r = await orch.cancel();
    expect(r).toBe(false);
  });

  it('plan content (instead of prompt) generates an execute-plan prompt', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const planSpy = vi.spyOn(deps, 'spawn');
    await orch.start({ repo: '/x', plan: '# Plan\n\nDo X', workRoot: '/y', maxDurationMs: 60_000 });
    const args = planSpy.mock.calls[0][1];
    const promptArg = args[args.indexOf('-p') + 1];
    expect(promptArg).toContain('Execute this implementation plan');
    expect(promptArg).toContain('# Plan');
  });

  it('gaming snapshot restored to its prior on-state if it was already on', async () => {
    const { deps, state } = makeDeps();
    deps.gaming.arm(); // gaming already on, no timer
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    state.child!.emit('exit', 0, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.gaming.snapshot().active).toBe(true);
  });
});
