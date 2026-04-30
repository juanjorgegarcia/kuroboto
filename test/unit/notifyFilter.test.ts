import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createServer, type DaemonContext } from '../../src/daemon/server.js';
import { PendingMap } from '../../src/daemon/pending.js';
import { PendingNotifications } from '../../src/daemon/pendingNotifications.js';
import { PendingReplies } from '../../src/daemon/pendingReplies.js';
import type { ConfigT } from '../../src/config/schema.js';
import * as stateModule from '../../src/daemon/state.js';
import { GamingState } from '../../src/daemon/gaming.js';
import { SleepingOrchestrator } from '../../src/daemon/sleeping.js';
import { InjectClients } from '../../src/daemon/injectClients.js';
import { MockChannel, noopLogger } from '../helpers/mockChannel.js';

// Don't touch host state during these tests.
const saveModeSpy = vi.spyOn(stateModule, 'saveMode').mockResolvedValue(undefined);
afterAll(() => {
  saveModeSpy.mockRestore();
});

const TEST_TOKEN = 'a'.repeat(64);

function makeContext(): { ctx: DaemonContext; channel: MockChannel } {
  const channel = new MockChannel();
  const config: ConfigT = {
    channel: { type: 'telegram', token: 'x', chatId: 1 },
    daemon: { port: 47892, authToken: TEST_TOKEN },
    inject: { enabled: false, replyTimeoutMs: 7_200_000 },
    policy: {
      permissionTimeoutMs: 1_000,
      // Immediate-send so the channel call is synchronous-enough for assertions.
      notifyDelayMs: 0,
      permissionMatchers: ['Bash'],
      rememberGranularity: 'tight',
      gamingAlwaysAsk: [],
      sleepMaxDurationMs: 7_200_000,
      sleepWorktreeDir: '/tmp/kuroboto-test-worktrees',
      maxConcurrentSleeps: 3,
      failOpen: true,
    },
  };
  const gaming = new GamingState();
  const sleeping = new SleepingOrchestrator({
    spawn: () => ({ on: () => {}, kill: () => {}, pid: 0, stdout: null, stderr: null } as never),
    gaming,
    notify: async () => {},
    audit: async () => {},
    createWorktree: async () => {},
    removeWorktree: async () => {},
    onSuccess: async () => {},
    maxConcurrent: 3,
    defaultModel: 'sonnet',
  });
  const ctx: DaemonContext = {
    config,
    channel,
    pending: new PendingMap(),
    pendingNotifications: new PendingNotifications(),
    pendingReplies: new PendingReplies(),
    inject: null,
    injectClients: new InjectClients(),
    state: { mode: 'away', gaming, sleeping },
    logger: noopLogger,
    startedAt: Date.now(),
    hostname: 'test-host',
  };
  return { ctx, channel };
}

async function postNotify(
  ctx: DaemonContext,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(createServer(ctx))
    .post('/v1/notify')
    .set('X-Kuroboto-Token', TEST_TOKEN)
    .send({ hook_event_name: 'Notification', ...body });
}

const QA_MESSAGE = 'Claude is waiting for your input';
const NOISY_MESSAGE = 'Claude needs your permission to use Bash';
const PROGRESS_MESSAGE = '[[KUROBOTO]] task 1 done: filter wired';

describe('/v1/notify gaming/sleep filter (Spec J1)', () => {
  let ctx: DaemonContext;
  let channel: MockChannel;

  beforeEach(() => {
    ({ ctx, channel } = makeContext());
  });

  describe('neither gaming nor sleep', () => {
    it('lets a noisy non-Q&A notification through', async () => {
      const res = await postNotify(ctx, { message: NOISY_MESSAGE, cwd: '/x/proj' });
      expect(res.status).toBe(200);
      expect(res.body.suppressed).toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(channel.sentNotifications.length).toBe(1);
    });
  });

  describe('gaming active', () => {
    beforeEach(() => {
      ctx.state.gaming.arm();
    });

    it('suppresses non-Q&A notifications', async () => {
      const res = await postNotify(ctx, { message: NOISY_MESSAGE, cwd: '/x/proj' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, suppressed: true });
      await new Promise((r) => setImmediate(r));
      expect(channel.sentNotifications).toEqual([]);
    });

    it('lets progress markers through', async () => {
      const res = await postNotify(ctx, { message: PROGRESS_MESSAGE, cwd: '/x/proj' });
      expect(res.status).toBe(200);
      expect(res.body.suppressed).toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(channel.sentNotifications.length).toBe(1);
    });
  });

  describe('sleep active', () => {
    beforeEach(() => {
      vi.spyOn(ctx.state.sleeping, 'snapshot').mockReturnValue({
        active: [
          {
            slug: 'demo-abc123',
            branch: 'sleep/demo-abc123',
            worktreePath: '/y/demo-abc123',
            startedAt: 0,
            expectedEndAt: 0,
          },
        ],
        capacity: 3,
      });
    });

    it('suppresses non-Q&A notifications from outside the sleep worktree', async () => {
      // Different cwd: not the autonomous-sleep stuck-session bypass.
      const res = await postNotify(ctx, { message: NOISY_MESSAGE, cwd: '/x/other' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, suppressed: true });
      await new Promise((r) => setImmediate(r));
      expect(channel.sentNotifications).toEqual([]);
    });

    it('lets progress markers through', async () => {
      const res = await postNotify(ctx, { message: PROGRESS_MESSAGE, cwd: '/y/demo-abc123' });
      expect(res.status).toBe(200);
      expect(res.body.suppressed).toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(channel.sentNotifications.length).toBe(1);
    });
  });

  describe('both gaming and sleep active', () => {
    beforeEach(() => {
      ctx.state.gaming.arm();
      vi.spyOn(ctx.state.sleeping, 'snapshot').mockReturnValue({
        active: [
          {
            slug: 'demo-abc123',
            branch: 'sleep/demo-abc123',
            worktreePath: '/y/demo-abc123',
            startedAt: 0,
            expectedEndAt: 0,
          },
        ],
        capacity: 3,
      });
    });

    it('suppresses non-Q&A non-marker notifications', async () => {
      const res = await postNotify(ctx, { message: NOISY_MESSAGE, cwd: '/x/other' });
      expect(res.body).toEqual({ ok: true, suppressed: true });
    });

    it('lets progress markers through', async () => {
      const res = await postNotify(ctx, { message: PROGRESS_MESSAGE, cwd: '/y/demo-abc123' });
      expect(res.body.suppressed).toBeUndefined();
    });
  });

  describe('Q&A bypass', () => {
    it('gaming on + Q&A message → bypasses filter (regular notif path, since inject is off here)', async () => {
      ctx.state.gaming.arm();
      const res = await postNotify(ctx, { message: QA_MESSAGE, cwd: '/x/proj' });
      expect(res.status).toBe(200);
      expect(res.body.suppressed).toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(channel.sentNotifications.length).toBe(1);
    });

    it('sleep on + Q&A message inside sleep worktree → bypasses filter (stuck-claude visibility preserved)', async () => {
      // shouldHandleAsQA returns false for sleep-cwd Q&A messages, but the
      // filter must not silence them — they're how the dev learns claude got
      // stuck mid-sleep.
      vi.spyOn(ctx.state.sleeping, 'snapshot').mockReturnValue({
        active: [
          {
            slug: 'stuck-abc123',
            branch: 'sleep/stuck-abc123',
            worktreePath: '/y/stuck-abc123',
            startedAt: 0,
            expectedEndAt: 0,
          },
        ],
        capacity: 3,
      });
      const res = await postNotify(ctx, { message: QA_MESSAGE, cwd: '/y/stuck-abc123' });
      expect(res.body.suppressed).toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(channel.sentNotifications.length).toBe(1);
    });
  });
});
