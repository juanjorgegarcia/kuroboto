import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer, type DaemonContext } from '../../src/daemon/server.js';
import { PendingMap } from '../../src/daemon/pending.js';
import type { ConfigT } from '../../src/config/schema.js';
import { MockChannel, noopLogger } from '../helpers/mockChannel.js';

const TEST_TOKEN = 'a'.repeat(64);

function makeContext(overrides: Partial<ConfigT> = {}): { ctx: DaemonContext; channel: MockChannel } {
  const channel = new MockChannel();
  const config: ConfigT = {
    channel: { type: 'telegram', token: 'x', chatId: 1 },
    daemon: { port: 47891, authToken: TEST_TOKEN },
    inject: { enabled: false },
    policy: { permissionTimeoutMs: 1_000, failOpen: true },
    ...overrides,
  };
  const pending = new PendingMap();
  const ctx: DaemonContext = {
    config,
    channel,
    pending,
    logger: noopLogger,
    startedAt: Date.now(),
  };
  channel.on('decision', (e) => pending.resolve(e.requestId, e.decision));
  return { ctx, channel };
}

describe('daemon HTTP', () => {
  let ctx: DaemonContext;
  let channel: MockChannel;

  beforeEach(() => {
    ({ ctx, channel } = makeContext());
  });

  it('GET /v1/health is open and returns ok', async () => {
    const res = await request(createServer(ctx)).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects requests without auth token (401)', async () => {
    const res = await request(createServer(ctx)).post('/v1/notify').send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong auth token (401)', async () => {
    const res = await request(createServer(ctx))
      .post('/v1/notify')
      .set('X-Kuroboto-Token', 'wrong')
      .send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('POST /v1/notify accepts and enqueues a notification', async () => {
    const res = await request(createServer(ctx))
      .post('/v1/notify')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'Notification', message: 'wake up', cwd: '/x/MyProject' });
    expect(res.status).toBe(200);
    // sendNotification is fired in the background; await a microtask
    await new Promise((r) => setImmediate(r));
    expect(channel.sentNotifications.length).toBe(1);
    expect(channel.sentNotifications[0]).toContain('MyProject');
    expect(channel.sentNotifications[0]).toContain('wake up');
  });

  it('POST /v1/permission resolves with allow when channel returns allow', async () => {
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
    const req = channel.sentPrompts[0];
    channel.emitDecision(req.requestId, { decision: 'allow', reason: 'tap' });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ decision: 'allow', reason: 'tap' });
  });

  it('POST /v1/permission resolves with deny when channel returns deny', async () => {
    const app = createServer(ctx);
    const pending = request(app)
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      })
      .then((r) => r);
    await waitFor(() => channel.sentPrompts.length === 1);
    channel.emitDecision(channel.sentPrompts[0].requestId, { decision: 'deny' });
    const res = await pending;
    expect(res.body.decision).toBe('deny');
  });

  it('POST /v1/permission resolves with timeout deny when nobody responds', async () => {
    const { ctx: shortCtx } = makeContext({ policy: { permissionTimeoutMs: 200, failOpen: true } });
    const res = await request(createServer(shortCtx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
    expect(res.body).toEqual({ decision: 'deny', reason: 'timeout' });
  });

  it('falls back to allow when sendPrompt throws (channel unavailable)', async () => {
    channel.throwOnSendPrompt = true;
    const res = await request(createServer(ctx))
      .post('/v1/permission')
      .set('X-Kuroboto-Token', TEST_TOKEN)
      .send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
    expect(res.body).toEqual({ decision: 'allow', reason: 'channel unavailable' });
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}
