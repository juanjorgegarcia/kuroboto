/**
 * Watchdog Telegram notification routing — covers PR #29 review #9: in
 * forumMode, watchdog crash/respawn notifs must go to the `kuroboto-system`
 * topic when one is cached, otherwise fall back to the main chat.
 *
 * The lifecycle.test.ts harness mocks notifyImpl as a pure capture, so the
 * forum-routing logic itself is uncovered there. This file pokes at the
 * real `sendWatchdogNotification` with a stubbed fetchImpl.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendWatchdogNotification } from '../../../src/watchdog/notify.js';

let tmpDir: string;
let lastBody: Record<string, unknown> | null;
let fakeFetchImpl: typeof fetch;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wd-notify-'));
  lastBody = null;
  fakeFetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    lastBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('sendWatchdogNotification — forumMode routing', () => {
  it('forumMode=false: never sets message_thread_id', async () => {
    const ok = await sendWatchdogNotification({
      token: 't',
      chatId: 42,
      forumMode: false,
      text: 'hello',
      fetchImpl: fakeFetchImpl,
      topicsFile: path.join(tmpDir, 'topics.json'),
    });
    expect(ok).toBe(true);
    expect(lastBody).toMatchObject({ chat_id: 42, text: 'hello' });
    expect(lastBody).not.toHaveProperty('message_thread_id');
  });

  it('forumMode=true + kuroboto-system topic cached: routes to that thread', async () => {
    const topicsFile = path.join(tmpDir, 'topics.json');
    await fsp.writeFile(
      topicsFile,
      JSON.stringify({ 'kuroboto-system': 4242, 'some-other-slug': 999 }),
    );

    const ok = await sendWatchdogNotification({
      token: 't',
      chatId: 42,
      forumMode: true,
      text: 'crashy crash',
      fetchImpl: fakeFetchImpl,
      topicsFile,
    });
    expect(ok).toBe(true);
    expect(lastBody).toMatchObject({
      chat_id: 42,
      text: 'crashy crash',
      message_thread_id: 4242,
    });
  });

  it('forumMode=true + missing topics.json: falls back to main chat (no message_thread_id)', async () => {
    const ok = await sendWatchdogNotification({
      token: 't',
      chatId: 42,
      forumMode: true,
      text: 'fallback',
      fetchImpl: fakeFetchImpl,
      topicsFile: path.join(tmpDir, 'does-not-exist.json'),
    });
    expect(ok).toBe(true);
    expect(lastBody).toMatchObject({ chat_id: 42, text: 'fallback' });
    expect(lastBody).not.toHaveProperty('message_thread_id');
  });

  it('forumMode=true + topics.json missing kuroboto-system entry: falls back to main chat', async () => {
    const topicsFile = path.join(tmpDir, 'topics.json');
    await fsp.writeFile(topicsFile, JSON.stringify({ 'feature-x': 100, 'feature-y': 200 }));

    const ok = await sendWatchdogNotification({
      token: 't',
      chatId: 42,
      forumMode: true,
      text: 'no system topic yet',
      fetchImpl: fakeFetchImpl,
      topicsFile,
    });
    expect(ok).toBe(true);
    expect(lastBody).not.toHaveProperty('message_thread_id');
  });
});
