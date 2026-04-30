import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createServer, type DaemonContext } from '../../src/daemon/server.js';
import { PendingMap } from '../../src/daemon/pending.js';
import { PendingNotifications } from '../../src/daemon/pendingNotifications.js';
import { PendingReplies } from '../../src/daemon/pendingReplies.js';
import type { ConfigT } from '../../src/config/schema.js';
import * as stateModule from '../../src/daemon/state.js';
import type { Mode } from '../../src/daemon/state.js';
import { GamingState } from '../../src/daemon/gaming.js';
import { SleepingOrchestrator } from '../../src/daemon/sleeping.js';
import { InjectClients } from '../../src/daemon/injectClients.js';
import type { InjectStrategy } from '../../src/inject/index.js';
import { MockChannel, noopLogger } from '../helpers/mockChannel.js';

// Prevent integration tests from mutating ~/.config/kuroboto/state.json on the host.
const saveModeSpy = vi.spyOn(stateModule, 'saveMode').mockResolvedValue(undefined);
afterAll(() => {
  saveModeSpy.mockRestore();
});

const TEST_TOKEN = 'a'.repeat(64);

interface Overrides {
  mode?: Mode;
  policy?: Partial<ConfigT['policy']>;
  inject?: ConfigT['inject'];
  injectStrategy?: InjectStrategy | null;
}

function makeContext(overrides: Overrides = {}): {
  ctx: DaemonContext;
  channel: MockChannel;
  pendingReplies: PendingReplies;
  injectClients: InjectClients;
} {
  const channel = new MockChannel();
  const config: ConfigT = {
    channel: { type: 'telegram', token: 'x', chatId: 1 },
    daemon: { port: 47891, authToken: TEST_TOKEN },
    inject: overrides.inject ?? { enabled: false, replyTimeoutMs: 7_200_000 },
    policy: {
      permissionTimeoutMs: 1_000,
      notifyDelayMs: 60_000,
      permissionMatchers: ['Bash', 'Edit', 'Write'],
      rememberGranularity: 'tight',
      gamingAlwaysAsk: [],
      sleepMaxDurationMs: 7_200_000,
      sleepWorktreeDir: '/tmp/kuroboto-test-worktrees',
      maxConcurrentSleeps: 3,
      failOpen: true,
      ...overrides.policy,
    },
  };
  const pending = new PendingMap();
  const pendingNotifications = new PendingNotifications();
  const pendingReplies = new PendingReplies();
  const gaming = new GamingState();
  const sleeping = new SleepingOrchestrator({
    spawn: () => ({ on: () => {}, kill: () => {}, pid: 0 } as never),
    gaming,
    notify: async () => {},
    audit: async () => {},
    createWorktree: async () => {},
    removeWorktree: async () => {},
    onSuccess: async () => {},
    maxConcurrent: 3,
    defaultModel: 'sonnet',
  });
  const injectClients = new InjectClients();
  const ctx: DaemonContext = {
    config,
    channel,
    pending,
    pendingNotifications,
    pendingReplies,
    inject: overrides.injectStrategy ?? null,
    injectClients,
    state: { mode: overrides.mode ?? 'here', gaming, sleeping },
    logger: noopLogger,
    startedAt: Date.now(),
    hostname: 'test-host',
  };
  channel.on('decision', (e) => pending.resolve(e.requestId, e.decision));
  channel.on('freeText', (e) => {
    if (e.replyToMessageId) pendingReplies.resolveBySentMessageId(e.replyToMessageId, e.text);
  });
  return { ctx, channel, pendingReplies, injectClients };
}

async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

describe('daemon HTTP', () => {
  let ctx: DaemonContext;
  let channel: MockChannel;

  beforeEach(() => {
    ({ ctx, channel } = makeContext());
  });

  it('GET /v1/health is open and reports mode + counters', async () => {
    const res = await request(createServer(ctx)).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe('here');
    expect(res.body.pending).toBe(0);
    expect(res.body.pendingNotifications).toBe(0);
  });

  it('rejects requests without auth token (401)', async () => {
    const res = await request(createServer(ctx)).post('/v1/notify').send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('GET /v1/mode requires auth', async () => {
    const res = await request(createServer(ctx)).get('/v1/mode');
    expect(res.status).toBe(401);
  });

  it('PUT /v1/mode toggles state.mode in memory', async () => {
    const app = createServer(ctx);
    const r1 = await request(app)
      .put('/v1/mode')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ mode: 'away' });
    expect(r1.status).toBe(200);
    expect(r1.body.mode).toBe('away');
    expect(ctx.state.mode).toBe('away');

    const r2 = await request(app).get('/v1/mode').set('X-Kuroboto-Token', TEST_TOKEN);
    expect(r2.body.mode).toBe('away');

    const bad = await request(app)
      .put('/v1/mode')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ mode: 'wrong' });
    expect(bad.status).toBe(400);
  });

  it('POST /v1/notify in here mode arms a pending notification (delayed)', async () => {
    const res = await request(createServer(ctx))
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'Notification', message: 'm', cwd: '/x/Project' });
    expect(res.status).toBe(200);
    expect(res.body.delayed).toBe(true);
    expect(ctx.pendingNotifications.size()).toBe(1);
    // No push sent yet — it's queued until the delay or until heartbeat clears it
    expect(channel.sentNotifications.length).toBe(0);
  });

  it('POST /v1/notify in away mode pushes immediately (no delay)', async () => {
    ctx.state.mode = 'away';
    const res = await request(createServer(ctx))
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'Notification', message: 'm', cwd: '/x/Project' });
    expect(res.status).toBe(200);
    expect(res.body.delayed).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(channel.sentNotifications.length).toBe(1);
    expect(channel.sentNotifications[0]).toContain('Project');
  });

  it('POST /v1/heartbeat cancels every pending notification', async () => {
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'Notification', message: 'a' });
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'Notification', message: 'b' });
    expect(ctx.pendingNotifications.size()).toBe(2);

    const res = await request(app).post('/v1/heartbeat').set('X-Kuroboto-Token', TEST_TOKEN);
    expect(res.body).toMatchObject({ ok: true, cancelled: 2 });
    expect(ctx.pendingNotifications.size()).toBe(0);
    expect(channel.sentNotifications.length).toBe(0);
  });

  it('POST /v1/permission in here mode returns ask without touching the channel', async () => {
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(res.body).toEqual({ decision: 'ask' });
    expect(channel.sentPrompts.length).toBe(0);
  });

  it('POST /v1/permission in away mode returns ask for tools outside the matcher', async () => {
    ctx.state.mode = 'away';
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
    expect(res.body).toEqual({ decision: 'ask' });
    expect(channel.sentPrompts.length).toBe(0);
  });

  it('POST /v1/permission in away mode + matched tool resolves with allow when channel returns allow', async () => {
    ctx.state.mode = 'away';
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        cwd: '/x/MyProject',
      })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'allow', reason: 'tap' });
    const res = await pending;
    expect(res.body).toEqual({ decision: 'allow', reason: 'tap' });
  });

  it('POST /v1/permission in away mode resolves with timeout deny when nobody responds', async () => {
    const { ctx: shortCtx } = makeContext({
      mode: 'away',
      policy: { permissionTimeoutMs: 200 },
    });
    const res = await request(createServer(shortCtx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
    expect(res.body).toEqual({ decision: 'deny', reason: 'timeout' });
  });

  it('POST /v1/permission falls back to ask when sendPrompt throws (channel unavailable)', async () => {
    ctx.state.mode = 'away';
    channel.throwOnSendPrompt = true;
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
    expect(res.body).toEqual({ decision: 'ask', reason: 'channel unavailable' });
  });

  it('POST /v1/permission envia 4 botões para o channel', async () => {
    ctx.state.mode = 'away';
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    expect(channel.sentPrompts[0].buttons.map((b) => b.action))
      .toEqual(['allow', 'allow_remember', 'deny', 'deny_note']);
    channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'deny' });
    await pending;
  });

  it('POST /v1/permission persiste matcher quando decision.remember=true', async () => {
    const tmpCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-int-'));
    try {
      ctx.state.mode = 'away';
      const app = createServer(ctx);
      const pending = request(app)
        .post('/v1/permission')
        .set('X-Kuroboto-Token', TEST_TOKEN)
        .send({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm install lodash' },
          cwd: tmpCwd,
        })
        .then((r) => r);
      await waitFor(() => channel.sentPrompts.length === 1);
      channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'allow', remember: true });
      const res = await pending;
      // hook não deve receber `remember`
      expect(res.body).toEqual({ decision: 'allow' });
      const settings = JSON.parse(
        await fsp.readFile(path.join(tmpCwd, '.claude', 'settings.local.json'), 'utf-8'),
      );
      expect(settings.permissions.allow).toContain('Bash(npm install:*)');
    } finally {
      await fsp.rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it('POST /v1/permission devolve deny + reason vindo do note flow', async () => {
    ctx.state.mode = 'away';
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm' }, cwd: '/x' })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    channel.emitDecision(channel.sentPrompts[0].requestId, {
      decision: 'deny',
      reason: 'não destrua nada',
    });
    const res = await pending;
    expect(res.body).toEqual({ decision: 'deny', reason: 'não destrua nada' });
  });

  it('PUT /v1/gaming { on: true } makes /v1/permission return allow instantly', async () => {
    const app = createServer(ctx);
    const r = await request(app)
      .put('/v1/gaming')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ on: true });
    expect(r.body).toMatchObject({ ok: true, active: true, until: null });

    const res = await request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' });
    expect(res.body).toEqual({ decision: 'allow', reason: 'gaming' });
  });

  it('PUT /v1/gaming { on: true, durationMs } sets `until` and auto-offs', async () => {
    const app = createServer(ctx);
    const r = await request(app)
      .put('/v1/gaming')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ on: true, durationMs: 50 });
    expect(r.body.active).toBe(true);
    expect(r.body.until).toBeGreaterThan(Date.now());

    await new Promise((r) => setTimeout(r, 80));

    const status = await request(app).get('/v1/gaming').set('X-Kuroboto-Token', TEST_TOKEN);
    expect(status.body).toEqual({ active: false, until: null });
  });

  it('PUT /v1/gaming { on: false } cancels active gaming', async () => {
    const app = createServer(ctx);
    ctx.state.gaming.arm(1_000_000);
    const r = await request(app)
      .put('/v1/gaming')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ on: false });
    expect(r.body).toEqual({ ok: true, active: false, until: null });
  });

  it('PUT /v1/gaming rejects bad body', async () => {
    const app = createServer(ctx);
    const r1 = await request(app)
      .put('/v1/gaming')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ foo: 'bar' });
    expect(r1.status).toBe(400);
    const r2 = await request(app)
      .put('/v1/gaming')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ on: true, durationMs: -5 });
    expect(r2.status).toBe(400);
  });

  it('gamingAlwaysAsk: [Bash] keeps Bash going through normal flow even when gaming on', async () => {
    const { ctx: c, channel: ch } = makeContext({
      mode: 'away',
      policy: { gamingAlwaysAsk: ['Bash'] },
    });
    c.state.gaming.arm();
    const app = createServer(c);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' })
      .then((r) => r);
    await waitFor(() => ch.sentPrompts.length === 1);
    // Edit, by contrast, would short-circuit:
    const editRes = await request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x' }, cwd: '/x' });
    expect(editRes.body).toEqual({ decision: 'allow', reason: 'gaming' });
    ch.emitDecision(ch.sentPrompts[0].requestId, { decision: 'deny' });
    await pending;
  });
});

describe('sleep mode endpoints', () => {
  let ctx: DaemonContext;
  beforeEach(() => {
    ({ ctx } = makeContext());
  });

  it('GET /v1/sleeping returns empty active list with capacity when no session', async () => {
    const res = await request(createServer(ctx))
      .get('/v1/sleeping')
      .set('X-Kuroboto-Token', TEST_TOKEN);
    expect(res.body).toEqual({ active: [], capacity: 3 });
  });

  it('POST /v1/sleeping rejects empty body', async () => {
    const res = await request(createServer(ctx))
      .post('/v1/sleeping')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /v1/sleeping rejects without prompt or plan', async () => {
    const res = await request(createServer(ctx))
      .post('/v1/sleeping')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ repo: '/tmp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt or plan/);
  });

  it('POST /v1/sleeping rejects when both prompt and plan given', async () => {
    const res = await request(createServer(ctx))
      .post('/v1/sleeping')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ repo: '/tmp', prompt: 'a', plan: 'b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mutually exclusive/);
  });

  it('DELETE /v1/sleeping returns cancelled=false when idle', async () => {
    const res = await request(createServer(ctx))
      .delete('/v1/sleeping')
      .set('X-Kuroboto-Token', TEST_TOKEN);
    expect(res.body).toEqual({ ok: true, cancelled: false, slugs: [], reason: 'idle' });
  });

  it('POST /v1/sleeping returns 429 with capacity body when at cap', async () => {
    // Fake the orchestrator to report at capacity
    vi.spyOn(ctx.state.sleeping, 'start').mockImplementation(async () => {
      const err = new Error('capacity reached (3/3)') as Error & { name: string; capacity: number; active: unknown[] };
      err.name = 'CapacityReachedError';
      err.capacity = 3;
      err.active = [
        { slug: 'a-xyz789', branch: 'sleep/a', worktreePath: '/x/a', startedAt: 1, expectedEndAt: 2 },
      ];
      throw err;
    });
    const res = await request(createServer(ctx))
      .post('/v1/sleeping')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ repo: '/r', prompt: 'test' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: 'capacity reached',
      capacity: 3,
    });
    expect(res.body.active).toBeInstanceOf(Array);
  });

  it('POST /v1/sleeping/cancel with slug routes to orchestrator.cancel({slug})', async () => {
    const cancelSpy = vi.spyOn(ctx.state.sleeping, 'cancel').mockResolvedValue({ cancelled: ['target-slug'] });
    const res = await request(createServer(ctx))
      .post('/v1/sleeping/cancel')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'target-slug' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: ['target-slug'] });
    expect(cancelSpy).toHaveBeenCalledWith({ slug: 'target-slug' });
  });

  it('POST /v1/sleeping/cancel with all=true routes to orchestrator.cancel({all})', async () => {
    const cancelSpy = vi.spyOn(ctx.state.sleeping, 'cancel').mockResolvedValue({ cancelled: ['a', 'b'] });
    const res = await request(createServer(ctx))
      .post('/v1/sleeping/cancel')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ all: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: ['a', 'b'] });
    expect(cancelSpy).toHaveBeenCalledWith({ all: true });
  });
});

describe('topics + chat clear endpoints', () => {
  it('POST /v1/topics/clear { slug } forwards keys: [slug]', async () => {
    const { ctx, channel } = makeContext();
    channel.clearTopicsImpl = async (opts) => ({ cleared: opts.keys ?? [], failed: [] });
    const res = await request(createServer(ctx))
      .post('/v1/topics/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'feat-x' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cleared: ['feat-x'], failed: [], dryRun: false });
    expect(channel.clearTopicsCalls).toHaveLength(1);
    expect(channel.clearTopicsCalls[0]).toEqual({ keys: ['feat-x'] });
  });

  it('POST /v1/topics/clear { all: true } sets except: [kuroboto-system]', async () => {
    const { ctx, channel } = makeContext();
    channel.clearTopicsImpl = async (opts) => ({
      cleared: opts.all ? ['a', 'b'] : [],
      failed: [],
    });
    const res = await request(createServer(ctx))
      .post('/v1/topics/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ all: true });
    expect(res.status).toBe(200);
    expect(channel.clearTopicsCalls[0]).toEqual({ all: true, except: ['kuroboto-system'] });
  });

  it('POST /v1/topics/clear with empty body returns 400', async () => {
    const { ctx } = makeContext();
    const res = await request(createServer(ctx))
      .post('/v1/topics/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slug.*all/);
  });

  it('POST /v1/topics/clear { dryRun: true } passes dryRun through', async () => {
    const { ctx, channel } = makeContext();
    const res = await request(createServer(ctx))
      .post('/v1/topics/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'foo', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(channel.clearTopicsCalls[0].dryRun).toBe(true);
  });

  it('POST /v1/topics/clear returns 400 when channel does not implement clearTopics', async () => {
    const { ctx, channel } = makeContext();
    // remove the implementation defined on MockChannel
    (channel as unknown as { clearTopics?: unknown }).clearTopics = undefined;
    const res = await request(createServer(ctx))
      .post('/v1/topics/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/forum topics/);
  });

  it('POST /v1/chat/clear { last: 10 } forwards last and returns counts', async () => {
    const { ctx, channel } = makeContext();
    channel.clearLastMessagesImpl = async (n) => ({ attempted: n, deleted: n - 2, outOfWindow: 2 });
    const res = await request(createServer(ctx))
      .post('/v1/chat/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ last: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, attempted: 10, deleted: 8, outOfWindow: 2, dryRun: false });
    expect(channel.clearLastMessagesCalls).toHaveLength(1);
    expect(channel.clearLastMessagesCalls[0]).toEqual({ n: 10, dryRun: false });
  });

  it('POST /v1/chat/clear rejects last <= 0', async () => {
    const { ctx } = makeContext();
    const res = await request(createServer(ctx))
      .post('/v1/chat/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ last: 0 });
    expect(res.status).toBe(400);
  });

  it('POST /v1/chat/clear rejects non-integer last', async () => {
    const { ctx } = makeContext();
    const res = await request(createServer(ctx))
      .post('/v1/chat/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ last: 'ten' });
    expect(res.status).toBe(400);
  });

  it('POST /v1/chat/clear { dryRun: true } passes dryRun through', async () => {
    const { ctx, channel } = makeContext();
    channel.clearLastMessagesImpl = async (n, opts) => ({
      attempted: n,
      deleted: 0,
      outOfWindow: opts?.dryRun ? 1 : 0,
    });
    const res = await request(createServer(ctx))
      .post('/v1/chat/clear')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ last: 5, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(channel.clearLastMessagesCalls[0]).toEqual({ n: 5, dryRun: true });
  });
});

describe('allowlist match (daemon-side)', () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-allowmatch-int-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpRepo, { recursive: true, force: true });
  });

  async function writeSettings(repo: string, perms: { allow?: string[]; deny?: string[] }): Promise<void> {
    const dir = path.join(repo, '.claude');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'settings.local.json'), JSON.stringify({ permissions: perms }));
  }

  it('allow match short-circuits to allow without Telegram prompt', async () => {
    const { ctx, channel } = makeContext({ mode: 'away' });
    await writeSettings(tmpRepo, { allow: ['Bash(echo:*)'] });
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        cwd: tmpRepo,
      });
    expect(res.body).toEqual({ decision: 'allow', reason: 'allowlist' });
    expect(channel.sentPrompts.length).toBe(0);
  });

  it('deny match short-circuits to deny without Telegram prompt', async () => {
    const { ctx, channel } = makeContext({ mode: 'away' });
    await writeSettings(tmpRepo, { deny: ['Bash(rm:*)'] });
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
        cwd: tmpRepo,
      });
    expect(res.body).toEqual({ decision: 'deny', reason: 'allowlist' });
    expect(channel.sentPrompts.length).toBe(0);
  });

  it('deny wins over allow when both match', async () => {
    const { ctx } = makeContext({ mode: 'away' });
    await writeSettings(tmpRepo, { allow: ['Bash'], deny: ['Bash(rm:*)'] });
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm foo' },
        cwd: tmpRepo,
      });
    expect(res.body).toEqual({ decision: 'deny', reason: 'allowlist' });
  });

  it('no match falls through to Telegram prompt', async () => {
    const { ctx, channel } = makeContext({ mode: 'away' });
    await writeSettings(tmpRepo, { allow: ['Bash(npm:*)'] });
    const pending = request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm foo' },
        cwd: tmpRepo,
      })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'deny' });
    await pending;
  });

  it('missing cwd falls through to Telegram prompt', async () => {
    const { ctx, channel } = makeContext({ mode: 'away' });
    const pending = request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'allow' });
    await pending;
  });

  it('here mode bypasses allowlist (returns ask, lets Claude UI decide)', async () => {
    const { ctx, channel } = makeContext({ mode: 'here' });
    await writeSettings(tmpRepo, { allow: ['Bash(echo:*)'] });
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        cwd: tmpRepo,
      });
    expect(res.body).toEqual({ decision: 'ask' });
    expect(channel.sentPrompts.length).toBe(0);
  });
});

describe('prompt context header (session + intent)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-promptctx-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(name: string, lines: unknown[]): Promise<string> {
    const file = path.join(tmpDir, name);
    await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    return file;
  }

  it('interactive: prompt header has hostname / folder / first user msg + 💭 intent', async () => {
    const transcript = await writeTranscript('t.jsonl', [
      { role: 'user', content: 'fix the bot UX' },
      { role: 'assistant', content: "I'll start by reading the routes file" },
    ]);
    const { ctx, channel } = makeContext({ mode: 'away' });
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cat src/daemon/routes.ts' },
        cwd: '/x/kuroboto',
        transcript_path: transcript,
      })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    const text = channel.sentPrompts[0].text;
    expect(text).toContain('[test-host / kuroboto / "fix the bot UX"]');
    expect(text).toContain("💭 I'll start by reading the routes file");
    expect(text).toContain('Pode rodar?');
    expect(text).toContain('Bash: cat src/daemon/routes.ts');
    channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'allow' });
    await pending;
  });

  it('sleep mode: prompt header uses 💤 slug-without-suffix and skips first-user-msg', async () => {
    const transcript = await writeTranscript('s.jsonl', [
      { role: 'user', content: 'PLAN_INTRO boilerplate that should not surface' },
      { role: 'assistant', content: 'Working on step 1' },
    ]);
    const { ctx, channel } = makeContext({ mode: 'away' });
    const worktreePath = path.join(tmpDir, 'work', 'fix-the-bot-ux-abc123');
    vi.spyOn(ctx.state.sleeping, 'snapshot').mockReturnValue({
      active: [
        {
          slug: 'fix-the-bot-ux-abc123',
          branch: 'sleep/fix-the-bot-ux-abc123',
          worktreePath,
          startedAt: Date.now(),
          expectedEndAt: Date.now() + 60_000,
        },
      ],
      capacity: 3,
    });
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: worktreePath,
        transcript_path: transcript,
      })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    const text = channel.sentPrompts[0].text;
    expect(text).toContain('[test-host / 💤 fix-the-bot-ux]');
    expect(text).not.toContain('PLAN_INTRO');
    expect(text).toContain('💭 Working on step 1');
    channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'allow' });
    await pending;
  });
});

describe('Q&A flow (tmux inject)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-qa-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(name: string, lines: unknown[]): Promise<string> {
    const file = path.join(tmpDir, name);
    await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    return file;
  }

  function makeFakeInject(): { strategy: { inject: (t: string) => Promise<void> }; calls: string[]; failNext: { err: Error | null } } {
    const calls: string[] = [];
    const failNext = { err: null as Error | null };
    return {
      calls,
      failNext,
      strategy: {
        inject: async (text: string) => {
          calls.push(text);
          if (failNext.err) {
            const e = failNext.err;
            failNext.err = null;
            throw e;
          }
        },
      },
    };
  }

  it('QA notif + inject enabled → sendQuestion(forceReply), audit qa-pending, then on reply: inject + qa-injected + ✅', async () => {
    const transcript = await writeTranscript('q.jsonl', [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Quero rodar A ou B?' },
    ]);
    const fake = makeFakeInject();
    const { ctx, channel, pendingReplies } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'tmux', session: 'claude', replyTimeoutMs: 60_000 },
      injectStrategy: fake.strategy,
    });
    const app = createServer(ctx);
    const res = await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        cwd: '/x/kuroboto',
        transcript_path: transcript,
      });
    expect(res.body).toEqual({ ok: true, qa: true });
    await waitFor(() => channel.sentQuestions.length === 1);
    const q = channel.sentQuestions[0];
    expect(q.forceReply).toBe(true);
    expect(q.text).toContain('💭 Quero rodar A ou B?');
    expect(q.text).toContain('❓ Claude tá esperando uma resposta');
    expect(q.text).toContain('"fix it"');

    await waitFor(() => pendingReplies.size() === 1);
    // The mock channel assigns a sequential sentMessageId starting at 1000
    channel.emitFreeText('A', '1000');
    await waitFor(() => fake.calls.length === 1);
    expect(fake.calls).toEqual(['A']);
    await waitFor(() => channel.sentNotifications.includes('✅ Reply injetada'));
  });

  it('QA notif + inject fails at runtime → ❌ + reply text echoed back', async () => {
    const transcript = await writeTranscript('q2.jsonl', [
      { role: 'user', content: 'help' },
      { role: 'assistant', content: 'pick one' },
    ]);
    const fake = makeFakeInject();
    fake.failNext.err = new Error('tmux send-keys exited 1: no server');
    const { ctx, channel, pendingReplies } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'tmux', session: 'claude', replyTimeoutMs: 60_000 },
      injectStrategy: fake.strategy,
    });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        cwd: '/x/proj',
        transcript_path: transcript,
      });
    await waitFor(() => channel.sentQuestions.length === 1);
    await waitFor(() => pendingReplies.size() === 1);
    channel.emitFreeText('B', '1000');
    await waitFor(() => channel.sentNotifications.some((n) => n.startsWith('❌ Inject falhou')));
    const fail = channel.sentNotifications.find((n) => n.startsWith('❌ Inject falhou'))!;
    expect(fail).toContain('no server');
    expect(fail).toContain('Sua reply foi:\nB');
  });

  it('QA notif + reply never arrives → qa-timeout fires after replyTimeoutMs', async () => {
    const transcript = await writeTranscript('q3.jsonl', [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'continue?' },
    ]);
    const fake = makeFakeInject();
    const { ctx, channel } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'tmux', session: 'claude', replyTimeoutMs: 50 },
      injectStrategy: fake.strategy,
    });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        cwd: '/x/proj',
        transcript_path: transcript,
      });
    await waitFor(() => channel.sentQuestions.length === 1);
    await waitFor(() => channel.sentNotifications.some((n) => n.startsWith('⏱ Q&A expirou')));
    expect(fake.calls).toEqual([]);
  });

  it('non-QA notification + inject enabled → existing notif path (no sendQuestion)', async () => {
    const fake = makeFakeInject();
    const { ctx, channel } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'tmux', session: 'claude', replyTimeoutMs: 60_000 },
      injectStrategy: fake.strategy,
    });
    const app = createServer(ctx);
    const res = await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        message: 'something else entirely',
        cwd: '/x/proj',
      });
    expect(res.body).toMatchObject({ ok: true, delayed: false });
    await new Promise((r) => setImmediate(r));
    await waitFor(() => channel.sentNotifications.length === 1);
    expect(channel.sentQuestions.length).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('QA notification + inject disabled → existing notif path (no sendQuestion)', async () => {
    const { ctx, channel } = makeContext({
      mode: 'away',
      inject: { enabled: false, replyTimeoutMs: 60_000 },
    });
    const app = createServer(ctx);
    const res = await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        cwd: '/x/proj',
      });
    expect(res.body).toMatchObject({ ok: true, delayed: false });
    await waitFor(() => channel.sentNotifications.length === 1);
    expect(channel.sentQuestions.length).toBe(0);
  });

  it('QA notification inside an active sleep cwd → existing notif path (no Q&A in sleep)', async () => {
    const fake = makeFakeInject();
    const { ctx, channel } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'tmux', session: 'claude', replyTimeoutMs: 60_000 },
      injectStrategy: fake.strategy,
    });
    const worktreePath = path.join(tmpDir, 'sleep-work');
    vi.spyOn(ctx.state.sleeping, 'snapshot').mockReturnValue({
      active: [
        {
          slug: 'foo-abc123',
          branch: 'sleep/foo-abc123',
          worktreePath,
          startedAt: Date.now(),
          expectedEndAt: Date.now() + 60_000,
        },
      ],
      capacity: 3,
    });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        cwd: worktreePath,
      });
    await waitFor(() => channel.sentNotifications.length === 1);
    expect(channel.sentQuestions.length).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});

describe('inject-clients endpoints', () => {
  it('POST registers a CLI; GET lists it', async () => {
    const { ctx } = makeContext();
    const app = createServer(ctx);
    const reg = await request(app)
      .post('/v1/inject-clients')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'cli-1', pid: 1234, cwd: '/x/proj', localPort: 51234 });
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ ok: true, slug: 'cli-1' });

    const list = await request(app)
      .get('/v1/inject-clients')
      .set('X-Kuroboto-Token', TEST_TOKEN);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ slug: 'cli-1', pid: 1234, cwd: '/x/proj', localPort: 51234, sessions: [] });
  });

  it('POST returns 409 on slug collision (different pid)', async () => {
    const { ctx } = makeContext();
    const app = createServer(ctx);
    await request(app)
      .post('/v1/inject-clients')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'cli-1', pid: 1, cwd: '/x', localPort: 5000 });
    const collide = await request(app)
      .post('/v1/inject-clients')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'cli-1', pid: 2, cwd: '/x', localPort: 5001 });
    expect(collide.status).toBe(409);
    expect(collide.body.error).toMatch(/already in use by PID 1/);
  });

  it('POST 400 on missing fields', async () => {
    const { ctx } = makeContext();
    const app = createServer(ctx);
    const r = await request(app)
      .post('/v1/inject-clients')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'x' });
    expect(r.status).toBe(400);
  });

  it('DELETE removes a registered CLI', async () => {
    const { ctx } = makeContext();
    const app = createServer(ctx);
    await request(app)
      .post('/v1/inject-clients')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ slug: 'cli-1', pid: 1, cwd: '/x', localPort: 5000 });
    const del = await request(app)
      .delete('/v1/inject-clients/cli-1')
      .set('X-Kuroboto-Token', TEST_TOKEN);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, removed: true });

    const list = await request(app)
      .get('/v1/inject-clients')
      .set('X-Kuroboto-Token', TEST_TOKEN);
    expect(list.body).toHaveLength(0);
  });

  it('endpoints require auth token', async () => {
    const { ctx } = makeContext();
    const app = createServer(ctx);
    const r = await request(app).get('/v1/inject-clients');
    expect(r.status).toBe(401);
  });
});

describe('forumMode topic context routing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-topics-int-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(name: string, lines: unknown[]): Promise<string> {
    const file = path.join(tmpDir, name);
    await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    return file;
  }

  it('PreToolUse with cwd matching a registered CLI → sendPrompt ctx.slug = client slug', async () => {
    const { ctx, channel, injectClients } = makeContext({ mode: 'away' });
    injectClients.register({
      slug: 'proj-a',
      pid: 1,
      cwd: '/x/proj-a',
      localPort: 60000,
      registeredAt: Date.now(),
    });
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-A',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: '/x/proj-a',
      })
      .then((r) => r);
    await waitFor(() => channel.sentPromptsDetailed.length === 1);
    expect(channel.sentPromptsDetailed[0].ctx).toEqual({ slug: 'proj-a' });
    channel.emitDecision(channel.sentPromptsDetailed[0].req.requestId, { decision: 'allow' });
    await pending;
  });

  it('PreToolUse inside an active sleep worktree → sendPrompt ctx isSleep + sleep slug', async () => {
    const worktreePath = path.join(tmpDir, 'work', 'fix-bot-ux-abc123');
    const { ctx, channel } = makeContext({ mode: 'away' });
    vi.spyOn(ctx.state.sleeping, 'snapshot').mockReturnValue({
      active: [
        {
          slug: 'fix-bot-ux-abc123',
          branch: 'sleep/fix-bot-ux-abc123',
          worktreePath,
          startedAt: Date.now(),
          expectedEndAt: Date.now() + 60_000,
        },
      ],
      capacity: 3,
    });
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-S',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: worktreePath,
      })
      .then((r) => r);
    await waitFor(() => channel.sentPromptsDetailed.length === 1);
    expect(channel.sentPromptsDetailed[0].ctx).toEqual({
      slug: 'fix-bot-ux-abc123',
      isSleep: true,
    });
    channel.emitDecision(channel.sentPromptsDetailed[0].req.requestId, { decision: 'allow' });
    await pending;
  });

  it('PreToolUse with no matching CLI / sleep → sendPrompt ctx falls back to sessionId', async () => {
    const { ctx, channel } = makeContext({ mode: 'away' });
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        session_id: 'a3f9b2c1-rest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: '/x/some-project',
      })
      .then((r) => r);
    await waitFor(() => channel.sentPromptsDetailed.length === 1);
    expect(channel.sentPromptsDetailed[0].ctx).toEqual({
      sessionId: 'a3f9b2c1-rest',
      cwdBasename: 'some-project',
    });
    channel.emitDecision(channel.sentPromptsDetailed[0].req.requestId, { decision: 'allow' });
    await pending;
  });

  it('Notification (immediate, away mode) → sendNotification ctx matches the inject client slug', async () => {
    const { ctx, channel, injectClients } = makeContext({ mode: 'away' });
    injectClients.register({
      slug: 'proj-b',
      pid: 1,
      cwd: '/x/proj-b',
      localPort: 60001,
      registeredAt: Date.now(),
    });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        session_id: 'sess-N',
        message: 'plain notice',
        cwd: '/x/proj-b',
      });
    await waitFor(() => channel.sentNotificationsDetailed.length === 1);
    expect(channel.sentNotificationsDetailed[0].ctx).toEqual({ slug: 'proj-b' });
  });

  it('Q&A reply pipeline tags every channel call with the same routing context', async () => {
    const transcript = await writeTranscript('q.jsonl', [
      { role: 'user', content: 'help' },
      { role: 'assistant', content: 'pick A or B' },
    ]);
    const { ctx, channel, injectClients, pendingReplies } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'pty', replyTimeoutMs: 60_000 },
    });
    injectClients.register({
      slug: 'proj-q',
      pid: 1,
      cwd: '/x/proj-q',
      // localPort 1 is unreachable — we expect the inject to fail, but the
      // resulting "❌ Inject falhou" notification still gets the topic ctx.
      localPort: 1,
      registeredAt: Date.now(),
    });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        session_id: 'sess-Q',
        message: 'Claude is waiting for your input',
        cwd: '/x/proj-q',
        transcript_path: transcript,
      });
    await waitFor(() => channel.sentQuestionsDetailed.length === 1);
    expect(channel.sentQuestionsDetailed[0].ctx).toEqual({ slug: 'proj-q' });
    await waitFor(() => pendingReplies.size() === 1);
    channel.emitFreeText('A', '1000');
    await waitFor(
      () => channel.sentNotificationsDetailed.some((n) => n.text.startsWith('❌ Inject falhou')),
      5000,
    );
    const failNotif = channel.sentNotificationsDetailed.find((n) =>
      n.text.startsWith('❌ Inject falhou'),
    )!;
    expect(failNotif.ctx).toEqual({ slug: 'proj-q' });
  });

});

describe('Q&A flow (PTY inject)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-qa-pty-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(name: string, lines: unknown[]): Promise<string> {
    const file = path.join(tmpDir, name);
    await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    return file;
  }

  it('Notification with cwd matching a registered CLI binds session_id → slug', async () => {
    const { ctx, injectClients } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'pty', replyTimeoutMs: 60_000 },
    });
    injectClients.register({ slug: 'foo', pid: 1, cwd: '/x/proj', localPort: 60000, registeredAt: Date.now() });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        session_id: 'sess-A',
        message: 'plain notice',
        cwd: '/x/proj',
      });
    await new Promise((r) => setImmediate(r));
    expect(injectClients.lookupBySession('sess-A')?.slug).toBe('foo');
  });

  it('PreToolUse with cwd matching a registered CLI binds session_id → slug', async () => {
    const { ctx, injectClients } = makeContext({ mode: 'here' });
    injectClients.register({ slug: 'foo', pid: 1, cwd: '/x/proj', localPort: 60000, registeredAt: Date.now() });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-B',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: '/x/proj',
      });
    expect(injectClients.lookupBySession('sess-B')?.slug).toBe('foo');
  });

  it('Q&A reply routes to the registered CLI via /inject', async () => {
    const transcript = await writeTranscript('q.jsonl', [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Quero rodar A ou B?' },
    ]);

    // Stand up a fake CLI HTTP server
    const received: string[] = [];
    const cli = http.createServer((req, res) => {
      let body = '';
      req.on('data', (b: Buffer) => { body += b.toString(); });
      req.on('end', () => {
        if (req.headers['x-kuroboto-token'] !== TEST_TOKEN) {
          res.statusCode = 401; res.end(); return;
        }
        const parsed = JSON.parse(body) as { text: string };
        received.push(parsed.text);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => cli.listen(0, '127.0.0.1', () => resolve()));
    const cliPort = (cli.address() as { port: number }).port;

    try {
      const { ctx, channel, injectClients, pendingReplies } = makeContext({
        mode: 'away',
        inject: { enabled: true, strategy: 'pty', replyTimeoutMs: 60_000 },
      });
      injectClients.register({ slug: 'foo', pid: 1, cwd: '/x/proj', localPort: cliPort, registeredAt: Date.now() });

      const app = createServer(ctx);
      await request(app)
        .post('/v1/notify')
        .set('X-Kuroboto-Token', TEST_TOKEN)
        .send({
          hook_event_name: 'Notification',
          session_id: 'sess-1',
          message: 'Claude is waiting for your input',
          cwd: '/x/proj',
          transcript_path: transcript,
        });
      await waitFor(() => channel.sentQuestions.length === 1);
      await waitFor(() => pendingReplies.size() === 1);
      channel.emitFreeText('A', '1000');
      await waitFor(() => received.length === 1);
      expect(received).toEqual(['A']);
      await waitFor(() => channel.sentNotifications.includes('✅ Reply injetada'));
    } finally {
      await new Promise<void>((resolve) => cli.close(() => resolve()));
    }
  });

  it('Q&A reply with no registered client → ❌ Inject falhou: no client', async () => {
    const transcript = await writeTranscript('q2.jsonl', [
      { role: 'user', content: 'help' },
      { role: 'assistant', content: 'pick one' },
    ]);
    const { ctx, channel, pendingReplies } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'pty', replyTimeoutMs: 60_000 },
    });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        session_id: 'sess-X',
        message: 'Claude is waiting for your input',
        cwd: '/x/none',
        transcript_path: transcript,
      });
    await waitFor(() => channel.sentQuestions.length === 1);
    await waitFor(() => pendingReplies.size() === 1);
    channel.emitFreeText('B', '1000');
    await waitFor(() => channel.sentNotifications.some((n) => n.startsWith('❌ Inject falhou')));
    const fail = channel.sentNotifications.find((n) => n.startsWith('❌ Inject falhou'))!;
    expect(fail).toContain('no client registered for this session');
    expect(fail).toContain('Sua reply foi:\nB');
  });

  it('Q&A reply: CLI port dead → drop registration, fall back, audit qa-inject-failed', async () => {
    const transcript = await writeTranscript('q3.jsonl', [
      { role: 'user', content: 'help' },
      { role: 'assistant', content: 'pick' },
    ]);
    const { ctx, channel, injectClients, pendingReplies } = makeContext({
      mode: 'away',
      inject: { enabled: true, strategy: 'pty', replyTimeoutMs: 60_000 },
    });
    // localPort 1 is virtually guaranteed to be unreachable
    injectClients.register({ slug: 'foo', pid: 1, cwd: '/x/dead', localPort: 1, registeredAt: Date.now() });
    const app = createServer(ctx);
    await request(app)
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'Notification',
        session_id: 'sess-D',
        message: 'Claude is waiting for your input',
        cwd: '/x/dead',
        transcript_path: transcript,
      });
    await waitFor(() => channel.sentQuestions.length === 1);
    await waitFor(() => pendingReplies.size() === 1);
    channel.emitFreeText('C', '1000');
    await waitFor(() => channel.sentNotifications.some((n) => n.startsWith('❌ Inject falhou')), 5000);
    expect(injectClients.list()).toEqual([]); // dropped
  });
});
