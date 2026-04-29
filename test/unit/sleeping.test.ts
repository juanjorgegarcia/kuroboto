import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  SleepingOrchestrator,
  type SleepingDeps,
  type SpawnFn,
} from '../../src/daemon/sleeping.js';
import { GamingState } from '../../src/daemon/gaming.js';
import type { ChannelContext } from '../../src/channels/Channel.js';

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
  /** Last spawned child (legacy single-session shorthand for tests that only start one). */
  child?: FakeChild;
  /** All spawned children, in spawn order. Index by start order for multi-session tests. */
  children: FakeChild[];
  notifications: string[];
  notificationCtxs: (ChannelContext | undefined)[];
  audits: unknown[];
  worktreesCreated: { repo: string; branch: string; dir: string }[];
  worktreeRemoved: string[];
}

function makeDeps(opts: { maxConcurrent?: number } = {}): { deps: SleepingDeps; state: DepsState } {
  const state: DepsState = {
    children: [],
    notifications: [],
    notificationCtxs: [],
    audits: [],
    worktreesCreated: [],
    worktreeRemoved: [],
  };
  const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
    const child = new FakeChild();
    state.children.push(child);
    state.child = child;
    return child as unknown as ReturnType<SpawnFn>;
  };
  const deps: SleepingDeps = {
    spawn: spawnFn,
    gaming: new GamingState(),
    notify: async (msg, ctx) => {
      state.notifications.push(msg);
      state.notificationCtxs.push(ctx);
    },
    audit: async (e) => {
      state.audits.push(e);
    },
    createWorktree: async (repo, branch, dir) => {
      state.worktreesCreated.push({ repo, branch, dir });
    },
    removeWorktree: async (_repo, dir) => {
      state.worktreeRemoved.push(dir);
    },
    onSuccess: vi.fn(async (_session) => {}),
    maxConcurrent: opts.maxConcurrent ?? 3,
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

  it('initial: idle snapshot with capacity', () => {
    const { deps } = makeDeps({ maxConcurrent: 3 });
    const orch = new SleepingOrchestrator(deps);
    expect(orch.snapshot()).toEqual({ active: [], capacity: 3 });
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
    expect(state.worktreesCreated).toHaveLength(1);
    expect(state.worktreesCreated[0]).toEqual({
      repo: '/x/repo',
      branch: session.branch,
      dir: `/y/wt/${session.slug}`,
    });
    expect(deps.gaming.snapshot().active).toBe(true);
    expect(state.child).toBeDefined();
    const snap = orch.snapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0].slug).toMatch(/^implement-billing-flow-[a-z0-9]{6}$/);
  });

  it('two concurrent starts both succeed when under capacity', async () => {
    const { deps, state } = makeDeps({ maxConcurrent: 3 });
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    await orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 });
    expect(orch.snapshot().active).toHaveLength(2);
    expect(state.children).toHaveLength(2);
    expect(state.worktreesCreated).toHaveLength(2);
  });

  it('rejects start when at capacity', async () => {
    const { deps } = makeDeps({ maxConcurrent: 1 });
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    await expect(
      orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 }),
    ).rejects.toThrow(/capacity/i);
  });

  it('CapacityReachedError carries capacity + active list', async () => {
    const { deps } = makeDeps({ maxConcurrent: 2 });
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    await orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 });
    try {
      await orch.start({ repo: '/x', prompt: 'c', workRoot: '/y', maxDurationMs: 60_000 });
      throw new Error('expected throw');
    } catch (e) {
      const err = e as Error & { capacity?: number; active?: unknown[] };
      expect(err.name).toBe('CapacityReachedError');
      expect(err.capacity).toBe(2);
      expect(err.active).toHaveLength(2);
    }
  });

  it('child exit 0 → onSuccess called, gaming restored, state idle', async () => {
    const { deps, state } = makeDeps();
    const gaming = deps.gaming;
    const orch = new SleepingOrchestrator(deps);
    expect(gaming.snapshot().active).toBe(false);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    expect(gaming.snapshot().active).toBe(true);
    state.child!.emit('exit', 0, null);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(deps.onSuccess).toHaveBeenCalledTimes(1);
    expect(gaming.snapshot().active).toBe(false);
    expect(orch.snapshot().active).toEqual([]);
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
    expect(orch.snapshot().active).toEqual([]);
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
    expect(orch.snapshot().active).toEqual([]);
  });

  it('handleChildExit non-zero → notifyDesktop fires with error level + slug', async () => {
    const { deps, state } = makeDeps();
    const desktopCalls: Array<{ title: string; body: string; level: string }> = [];
    deps.notifyDesktop = async (opts) => {
      desktopCalls.push(opts);
    };
    const orch = new SleepingOrchestrator(deps);
    const session = await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    state.child!.emit('exit', 1, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(desktopCalls).toHaveLength(1);
    expect(desktopCalls[0].level).toBe('error');
    expect(desktopCalls[0].body).toContain(session.slug);
  });

  it('handleTimeout → notifyDesktop fires with error level + timeout body', async () => {
    const { deps, state } = makeDeps();
    const desktopCalls: Array<{ title: string; body: string; level: string }> = [];
    deps.notifyDesktop = async (opts) => {
      desktopCalls.push(opts);
    };
    const orch = new SleepingOrchestrator(deps);
    const session = await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 50 });
    expect(state.child!.killed).toBe(false);
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    await Promise.resolve();
    expect(desktopCalls).toHaveLength(1);
    expect(desktopCalls[0].level).toBe('error');
    expect(desktopCalls[0].title.toLowerCase()).toContain('timeout');
    expect(desktopCalls[0].body).toContain(session.slug);
  });

  it('notifyDesktop omitted → child exit failure still notifies via Telegram', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    state.child!.emit('exit', 1, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.notifications.some((n) => n.includes('failed'))).toBe(true);
  });

  it('cancel() with single active session kills child, returns slug', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const session = await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    const cancelPromise = orch.cancel();
    vi.advanceTimersByTime(0);
    const r = await cancelPromise;
    expect(r.cancelled).toEqual([session.slug]);
    expect(state.child!.killed).toBe(true);
    expect(state.notifications.some((n) => n.toLowerCase().includes('cancel'))).toBe(true);
    expect(orch.snapshot().active).toEqual([]);
  });

  it('cancel() is no-op when idle (returns empty cancelled list)', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const r = await orch.cancel();
    expect(r).toEqual({ cancelled: [] });
  });

  it('cancel() throws when multiple active and no slug given', async () => {
    const { deps } = makeDeps({ maxConcurrent: 3 });
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    await orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 });
    await expect(orch.cancel()).rejects.toThrow(/multiple/i);
  });

  it('cancel({ slug }) cancels only the matching session', async () => {
    const { deps } = makeDeps({ maxConcurrent: 3 });
    const orch = new SleepingOrchestrator(deps);
    const a = await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    const b = await orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 });
    const cancelP = orch.cancel({ slug: a.slug });
    vi.advanceTimersByTime(0);
    const r = await cancelP;
    expect(r.cancelled).toEqual([a.slug]);
    const snap = orch.snapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0].slug).toBe(b.slug);
  });

  it('cancel({ all: true }) cancels every active session', async () => {
    const { deps } = makeDeps({ maxConcurrent: 3 });
    const orch = new SleepingOrchestrator(deps);
    const a = await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    const b = await orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 });
    const cancelP = orch.cancel({ all: true });
    vi.advanceTimersByTime(0);
    const r = await cancelP;
    expect(r.cancelled.sort()).toEqual([a.slug, b.slug].sort());
    expect(orch.snapshot().active).toEqual([]);
  });

  it('cancel({ slug }) on unknown slug returns empty', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    const r = await orch.cancel({ slug: 'does-not-exist' });
    expect(r.cancelled).toEqual([]);
    // The active session is not affected
    expect(orch.snapshot().active).toHaveLength(1);
  });

  it('one session finishing does not affect another concurrent session', async () => {
    const { deps, state } = makeDeps({ maxConcurrent: 3 });
    const orch = new SleepingOrchestrator(deps);
    const a = await orch.start({ repo: '/x', prompt: 'a', workRoot: '/y', maxDurationMs: 60_000 });
    await orch.start({ repo: '/x', prompt: 'b', workRoot: '/y', maxDurationMs: 60_000 });
    // Exit child A; B should still be alive
    state.children[0].emit('exit', 0, null);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const snap = orch.snapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0].slug).not.toBe(a.slug);
    // gaming is still on because session B is still active
    expect(deps.gaming.snapshot().active).toBe(true);
  });

  it('plan content (instead of prompt) generates an execute-plan prompt', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const planSpy = vi.spyOn(deps, 'spawn');
    await orch.start({ repo: '/x', plan: '# Plan\n\nDo X', workRoot: '/y', maxDurationMs: 60_000 });
    const args = planSpy.mock.calls[0][1];
    const promptArg = args[args.indexOf('-p') + 1];
    expect(promptArg).toContain('Execute this implementation plan');
    expect(promptArg).toContain('# Plan');
  });

  it('spawn args include --dangerously-skip-permissions before -p (Spec J2)', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const spawnSpy = vi.spyOn(deps, 'spawn');
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    const [cmd, args] = spawnSpy.mock.calls[0];
    expect(cmd).toBe('claude');
    const flagIdx = args.indexOf('--dangerously-skip-permissions');
    const pIdx = args.indexOf('-p');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeGreaterThan(flagIdx);
  });

  it('PLAN_INTRO carries the [[KUROBOTO]] marker protocol (Spec J3)', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const spawnSpy = vi.spyOn(deps, 'spawn');
    await orch.start({ repo: '/x', plan: '# Plan\n\nDo X', workRoot: '/y', maxDurationMs: 60_000 });
    const args = spawnSpy.mock.calls[0][1];
    const promptArg = args[args.indexOf('-p') + 1];
    expect(promptArg).toContain('[[KUROBOTO]]');
    expect(promptArg).toContain('progress markers');
    expect(promptArg).toContain('task N done');
  });

  it('PROMPT_OUTRO is appended to prompt-mode prompts (Spec J3)', async () => {
    const { deps } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const spawnSpy = vi.spyOn(deps, 'spawn');
    await orch.start({
      repo: '/x',
      prompt: 'fix the auth bug',
      workRoot: '/y',
      maxDurationMs: 60_000,
    });
    const args = spawnSpy.mock.calls[0][1];
    const promptArg = args[args.indexOf('-p') + 1];
    expect(promptArg.startsWith('fix the auth bug')).toBe(true);
    expect(promptArg).toContain('[[KUROBOTO]]');
    expect(promptArg).toContain('progress markers');
  });

  it('gaming snapshot restored to its prior on-state if it was already on', async () => {
    const { deps, state } = makeDeps();
    deps.gaming.arm(); // gaming already on, no timer
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    state.child!.emit('exit', 0, null);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(deps.gaming.snapshot().active).toBe(true);
  });

  it('gaming with prior timer restored to remaining duration after success', async () => {
    const { deps, state } = makeDeps();
    deps.gaming.arm(1000);
    const orch = new SleepingOrchestrator(deps);
    await orch.start({ repo: '/x', prompt: 'p', workRoot: '/y', maxDurationMs: 60_000 });
    vi.advanceTimersByTime(200);
    state.child!.emit('exit', 0, null);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const snap = deps.gaming.snapshot();
    expect(snap.active).toBe(true);
    expect(snap.until).not.toBeNull();
    const remaining = (snap.until ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(700);
    expect(remaining).toBeLessThan(900);
  });

  it('forwards isSleep ctx to notify on start, cancel, timeout, and failure', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const session = await orch.start({
      repo: '/x',
      prompt: 'p',
      workRoot: '/y',
      maxDurationMs: 60_000,
    });
    expect(state.notifications[0]).toContain('sleep started');
    expect(state.notificationCtxs[0]).toEqual({ slug: session.slug, isSleep: true });

    // Cancel
    const cancelP = orch.cancel({ slug: session.slug });
    await vi.advanceTimersByTimeAsync(0);
    await cancelP;
    expect(state.notifications.some((n) => n.includes('cancelled'))).toBe(true);
    const cancelIdx = state.notifications.findIndex((n) => n.includes('cancelled'));
    expect(state.notificationCtxs[cancelIdx]).toEqual({ slug: session.slug, isSleep: true });

    // Failure (non-zero exit)
    const session2 = await orch.start({
      repo: '/x',
      prompt: 'p2',
      workRoot: '/y',
      maxDurationMs: 60_000,
    });
    state.child!.emit('exit', 1, null);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const failIdx = state.notifications.findIndex((n) => n.includes('failed'));
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(state.notificationCtxs[failIdx]).toEqual({ slug: session2.slug, isSleep: true });
  });

  it('forwards isSleep ctx to notify on max-duration timeout', async () => {
    const { deps, state } = makeDeps();
    const orch = new SleepingOrchestrator(deps);
    const session = await orch.start({
      repo: '/x',
      prompt: 'p',
      workRoot: '/y',
      maxDurationMs: 100,
    });
    vi.advanceTimersByTime(150);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const tmIdx = state.notifications.findIndex((n) => n.includes('timed out'));
    expect(tmIdx).toBeGreaterThanOrEqual(0);
    expect(state.notificationCtxs[tmIdx]).toEqual({ slug: session.slug, isSleep: true });
  });
});
