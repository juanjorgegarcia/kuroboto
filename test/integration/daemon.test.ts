import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, type DaemonContext } from '../../src/daemon/server.js';
import { PendingMap } from '../../src/daemon/pending.js';
import { PendingNotifications } from '../../src/daemon/pendingNotifications.js';
import type { ConfigT } from '../../src/config/schema.js';
import * as stateModule from '../../src/daemon/state.js';
import type { Mode } from '../../src/daemon/state.js';
import { GamingState } from '../../src/daemon/gaming.js';
import { SleepingOrchestrator } from '../../src/daemon/sleeping.js';
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
}

function makeContext(overrides: Overrides = {}): { ctx: DaemonContext; channel: MockChannel } {
  const channel = new MockChannel();
  const config: ConfigT = {
    channel: { type: 'telegram', token: 'x', chatId: 1 },
    daemon: { port: 47891, authToken: TEST_TOKEN },
    inject: { enabled: false },
    policy: {
      permissionTimeoutMs: 1_000,
      notifyDelayMs: 60_000,
      permissionMatchers: ['Bash', 'Edit', 'Write'],
      rememberGranularity: 'tight',
      gamingAlwaysAsk: [],
      failOpen: true,
      ...overrides.policy,
    },
  };
  const pending = new PendingMap();
  const pendingNotifications = new PendingNotifications();
  const gaming = new GamingState();
  const sleeping = new SleepingOrchestrator({
    spawn: () => ({ on: () => {}, kill: () => {}, pid: 0 } as never),
    gaming,
    notify: async () => {},
    audit: async () => {},
    createWorktree: async () => {},
    removeWorktree: async () => {},
    onSuccess: async () => {},
  });
  const ctx: DaemonContext = {
    config,
    channel,
    pending,
    pendingNotifications,
    state: { mode: overrides.mode ?? 'here', gaming, sleeping },
    logger: noopLogger,
    startedAt: Date.now(),
    hostname: 'test-host',
  };
  channel.on('decision', (e) => pending.resolve(e.requestId, e.decision));
  return { ctx, channel };
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

  it('GET /v1/sleeping returns idle when no session', async () => {
    const res = await request(createServer(ctx))
      .get('/v1/sleeping')
      .set('X-Kuroboto-Token', TEST_TOKEN);
    expect(res.body).toEqual({ active: false });
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
    expect(res.body).toEqual({ ok: true, cancelled: false, reason: 'idle' });
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
