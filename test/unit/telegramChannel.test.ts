import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TelegramChannel } from '../../src/channels/telegram/TelegramChannel.js';
import { TopicManager } from '../../src/channels/telegram/topics.js';
import type { Decision } from '../../src/core/types.js';
import { noopLogger } from '../helpers/mockChannel.js';

class FakeApi {
  public messages: Array<{
    chatId: number;
    text: string;
    opts?: { messageThreadId?: number; keyboard?: unknown; forceReply?: boolean };
  }> = [];
  public callbacksAnswered: string[] = [];
  public editKeyboardCalls: Array<{ messageId: number; keyboard: unknown }> = [];
  public createTopicCalls: Array<{ chatId: number; name: string }> = [];
  public deleteMessageCalls: Array<{ chatId: number; messageId: number }> = [];
  public deleteForumTopicCalls: Array<{ chatId: number; threadId: number }> = [];
  /** Per-call programmable errors for deleteMessage / deleteForumTopic. */
  public deleteMessageErrors: Error[] = [];
  public deleteForumTopicErrors: Error[] = [];
  private nextMessageId = 100;
  private nextThreadId = 200;
  /** Per-call programmable error: pop the next error before each sendMessage. */
  public sendErrors: Error[] = [];

  async sendMessage(
    chatId: number,
    text: string,
    opts?: { messageThreadId?: number; keyboard?: unknown; forceReply?: boolean },
  ): Promise<number> {
    if (this.sendErrors.length > 0) {
      const e = this.sendErrors.shift()!;
      throw e;
    }
    this.messages.push({ chatId, text, opts });
    return this.nextMessageId++;
  }
  async answerCallbackQuery(id: string): Promise<void> {
    this.callbacksAnswered.push(id);
  }
  async editMessageReplyMarkup(_chat: number, messageId: number, keyboard: unknown): Promise<void> {
    this.editKeyboardCalls.push({ messageId, keyboard });
  }
  async createForumTopic(chatId: number, name: string): Promise<number> {
    this.createTopicCalls.push({ chatId, name });
    return this.nextThreadId++;
  }
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    this.deleteMessageCalls.push({ chatId, messageId });
    if (this.deleteMessageErrors.length > 0) throw this.deleteMessageErrors.shift()!;
  }
  async deleteForumTopic(chatId: number, threadId: number): Promise<void> {
    this.deleteForumTopicCalls.push({ chatId, threadId });
    if (this.deleteForumTopicErrors.length > 0) throw this.deleteForumTopicErrors.shift()!;
  }
  async getUpdates(): Promise<never[]> { return []; }
}

function makeChannel(api: FakeApi) {
  const ch = new TelegramChannel({ token: 't', chatId: 1, logger: noopLogger });
  // surgically swap the internal api with our fake
  (ch as unknown as { api: unknown }).api = api;
  return ch;
}

describe('TelegramChannel callbacks', () => {
  let api: FakeApi;
  let ch: TelegramChannel;
  let decisions: Array<{ requestId: string; decision: Decision }>;

  beforeEach(async () => {
    api = new FakeApi();
    ch = makeChannel(api);
    decisions = [];
    ch.on('decision', (e) => decisions.push(e));
    await ch.sendPrompt({
      requestId: 'req-1',
      text: 'pode rodar?',
      buttons: [
        { label: '✅', action: 'allow' },
        { label: '🔓', action: 'allow_remember' },
        { label: '❌', action: 'deny' },
        { label: '💬', action: 'deny_note' },
      ],
    });
  });

  function callback(action: string, requestId = 'req-1') {
    (ch as unknown as { handleUpdate(u: unknown): void }).handleUpdate({
      callback_query: { id: 'cb', from: { id: 1 }, message: { message_id: 100, chat: { id: 1 } }, data: `${requestId}:${action}` },
    });
  }
  function text(t: string) {
    (ch as unknown as { handleUpdate(u: unknown): void }).handleUpdate({
      message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' }, date: 0, text: t },
    });
  }

  it('allow → emit { decision: allow }', async () => {
    callback('allow');
    await new Promise((r) => setImmediate(r));
    expect(decisions).toEqual([{ requestId: 'req-1', decision: { decision: 'allow' } }]);
  });

  it('allow_remember → emit { decision: allow, remember: true }', async () => {
    callback('allow_remember');
    await new Promise((r) => setImmediate(r));
    expect(decisions).toEqual([{ requestId: 'req-1', decision: { decision: 'allow', remember: true } }]);
  });

  it('deny → emit { decision: deny }', async () => {
    callback('deny');
    await new Promise((r) => setImmediate(r));
    expect(decisions).toEqual([{ requestId: 'req-1', decision: { decision: 'deny' } }]);
  });

  it('deny_note → não emit imediato; próximo texto vira reason', async () => {
    callback('deny_note');
    await new Promise((r) => setImmediate(r));
    expect(decisions).toEqual([]);
    // edit pra mostrar prompt de "aguardando texto"
    expect(api.editKeyboardCalls.length).toBeGreaterThan(0);
    text('porque o comando faz X que eu não quero');
    expect(decisions).toEqual([{
      requestId: 'req-1',
      decision: { decision: 'deny', reason: 'porque o comando faz X que eu não quero' },
    }]);
  });

  it('texto sem deny_note pendente → emit freeText (comportamento legado)', async () => {
    const free: string[] = [];
    ch.on('freeText', (e) => free.push(e.text));
    text('hello');
    expect(decisions).toEqual([]);
    expect(free).toEqual(['hello']);
  });
});

describe('TelegramChannel topic routing', () => {
  let api: FakeApi;
  let dir: string;
  let storagePath: string;

  beforeEach(async () => {
    api = new FakeApi();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-tg-channel-'));
    storagePath = path.join(dir, 'topics.json');
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  function makeChannelWithTm(forumMode: boolean): TelegramChannel {
    const tm = new TopicManager({
      api,
      chatId: -100123,
      forumMode,
      storagePath,
      logger: noopLogger,
    });
    const ch = new TelegramChannel({
      token: 't',
      chatId: -100123,
      logger: noopLogger,
      topicManager: tm,
    });
    (ch as unknown as { api: unknown }).api = api;
    return ch;
  }

  it('forumMode off: sendNotification omits message_thread_id', async () => {
    const ch = makeChannelWithTm(false);
    await ch.sendNotification('hi', { slug: 'fix-bot-ux' });
    expect(api.messages).toHaveLength(1);
    expect(api.messages[0].opts?.messageThreadId).toBeUndefined();
    expect(api.createTopicCalls).toHaveLength(0);
  });

  it('forumMode on: first send creates topic, second send same key reuses it', async () => {
    const ch = makeChannelWithTm(true);
    await ch.sendNotification('first', { slug: 'fix-bot-ux' });
    await ch.sendNotification('second', { slug: 'fix-bot-ux' });
    expect(api.createTopicCalls).toEqual([{ chatId: -100123, name: 'fix-bot-ux' }]);
    expect(api.messages).toHaveLength(2);
    expect(api.messages[0].opts?.messageThreadId).toBe(200);
    expect(api.messages[1].opts?.messageThreadId).toBe(200);
  });

  it('forumMode on: sleep slug → topic name uses 💤 prefix and stripped suffix', async () => {
    const ch = makeChannelWithTm(true);
    await ch.sendNotification('💤', { slug: 'fix-bot-ux-abc123', isSleep: true });
    expect(api.createTopicCalls).toEqual([{ chatId: -100123, name: '💤 fix-bot-ux' }]);
  });

  it('forumMode on: missing context → kuroboto-system topic', async () => {
    const ch = makeChannelWithTm(true);
    await ch.sendNotification('hi');
    expect(api.createTopicCalls).toEqual([{ chatId: -100123, name: 'kuroboto-system' }]);
  });

  it('forumMode on: thread-not-found → purge and recreate', async () => {
    const ch = makeChannelWithTm(true);
    // First send creates topic 200
    await ch.sendNotification('warmup', { slug: 'fix-bot-ux' });
    // Next send: api fails with thread-not-found, channel should purge and retry
    api.sendErrors.push(new Error('telegram: Bad Request: message thread not found'));
    await ch.sendNotification('after-delete', { slug: 'fix-bot-ux' });
    expect(api.createTopicCalls).toHaveLength(2);
    expect(api.createTopicCalls[0].name).toBe('fix-bot-ux');
    expect(api.createTopicCalls[1].name).toBe('fix-bot-ux');
    // Final message used the new thread id
    expect(api.messages[api.messages.length - 1].opts?.messageThreadId).toBe(201);
  });

  it('forumMode on: createForumTopic failure → message goes to main chat (no thread id)', async () => {
    api.createForumTopic = async () => {
      throw new Error('rate limited');
    };
    const ch = makeChannelWithTm(true);
    await ch.sendNotification('hi', { slug: 'fix-bot-ux' });
    expect(api.messages).toHaveLength(1);
    expect(api.messages[0].opts?.messageThreadId).toBeUndefined();
  });
});

describe('TelegramChannel.clearTopics', () => {
  let tmpDir: string;
  let api: FakeApi;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-cleartopics-'));
    api = new FakeApi();
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function makeChannelWithTm(seed: Record<string, number> = {}): Promise<{
    ch: TelegramChannel;
    tm: TopicManager;
  }> {
    const storagePath = path.join(tmpDir, 'topics.json');
    await fsp.writeFile(storagePath, JSON.stringify(seed));
    const tm = new TopicManager({
      api: api as never,
      chatId: -100,
      forumMode: true,
      storagePath,
      logger: noopLogger,
    });
    await tm.loadFromDisk();
    const ch = new TelegramChannel({ token: 't', chatId: -100, logger: noopLogger, topicManager: tm });
    (ch as unknown as { api: unknown }).api = api;
    return { ch, tm };
  }

  it('throws when forumMode is off (no topicManager)', async () => {
    const ch = new TelegramChannel({ token: 't', chatId: -100, logger: noopLogger });
    await expect(ch.clearTopics({ all: true })).rejects.toThrow(/forumMode is off/i);
  });

  it('keys: [slug] calls deleteForumTopic on each cached threadId and purges', async () => {
    const { ch, tm } = await makeChannelWithTm({ 'feat-x': 11, 'feat-y': 22 });
    const result = await ch.clearTopics({ keys: ['feat-x'] });
    expect(result.cleared).toEqual(['feat-x']);
    expect(api.deleteForumTopicCalls).toEqual([{ chatId: -100, threadId: 11 }]);
    expect(tm.get('feat-x')).toBeUndefined();
    expect(tm.get('feat-y')).toBe(22);
  });

  it('all: true with except: [kuroboto-system] preserves the system topic', async () => {
    const { ch, tm } = await makeChannelWithTm({ 'feat-x': 11, 'kuroboto-system': 99 });
    const result = await ch.clearTopics({ all: true, except: ['kuroboto-system'] });
    expect(result.cleared).toEqual(['feat-x']);
    expect(api.deleteForumTopicCalls).toEqual([{ chatId: -100, threadId: 11 }]);
    expect(tm.get('kuroboto-system')).toBe(99);
  });

  it('dryRun returns the would-clear keys without calling the API', async () => {
    const { ch } = await makeChannelWithTm({ 'feat-x': 11, 'feat-y': 22 });
    const result = await ch.clearTopics({ all: true, dryRun: true });
    expect(result.cleared.sort()).toEqual(['feat-x', 'feat-y']);
    expect(api.deleteForumTopicCalls).toHaveLength(0);
  });

  it('treats "thread not found" as already-cleared and purges anyway', async () => {
    const { ch, tm } = await makeChannelWithTm({ 'feat-x': 11 });
    api.deleteForumTopicErrors.push(new Error('telegram: Bad Request: message thread not found'));
    const result = await ch.clearTopics({ keys: ['feat-x'] });
    expect(result.cleared).toEqual(['feat-x']);
    expect(result.failed).toEqual([]);
    expect(tm.get('feat-x')).toBeUndefined();
  });

  it('records real API failures in result.failed', async () => {
    const { ch } = await makeChannelWithTm({ 'feat-x': 11 });
    api.deleteForumTopicErrors.push(new Error('telegram: Forbidden'));
    const result = await ch.clearTopics({ keys: ['feat-x'] });
    expect(result.cleared).toEqual([]);
    expect(result.failed).toEqual([{ key: 'feat-x', error: expect.stringContaining('Forbidden') }]);
  });

  it('skips unknown keys silently', async () => {
    const { ch } = await makeChannelWithTm({ 'feat-x': 11 });
    const result = await ch.clearTopics({ keys: ['feat-x', 'never-existed'] });
    expect(result.cleared).toEqual(['feat-x']);
    expect(api.deleteForumTopicCalls).toHaveLength(1);
  });
});

describe('TelegramChannel.clearLastMessages', () => {
  let api: FakeApi;
  let ch: TelegramChannel;

  beforeEach(() => {
    api = new FakeApi();
    ch = makeChannel(api);
  });

  it('returns zero counts when nothing has been sent', async () => {
    const r = await ch.clearLastMessages(10);
    expect(r).toEqual({ attempted: 0, deleted: 0, outOfWindow: 0 });
  });

  it('takes the last N tracked outbound messages and deletes each', async () => {
    await ch.sendNotification('a');
    await ch.sendNotification('b');
    await ch.sendNotification('c');
    const r = await ch.clearLastMessages(2);
    expect(r).toEqual({ attempted: 2, deleted: 2, outOfWindow: 0 });
    expect(api.deleteMessageCalls.map((c) => c.messageId)).toEqual([101, 102]);
  });

  it('counts messages older than 48h as outOfWindow without calling the API', async () => {
    await ch.sendNotification('old');
    // Reach into the ring buffer and backdate the entry.
    const ring = (ch as unknown as { sentMessages: Array<{ messageId: number; sentAt: number }> }).sentMessages;
    ring[0]!.sentAt = Date.now() - 49 * 3600 * 1000;
    const r = await ch.clearLastMessages(1);
    expect(r).toEqual({ attempted: 1, deleted: 0, outOfWindow: 1 });
    expect(api.deleteMessageCalls).toHaveLength(0);
  });

  it('counts "can\'t be deleted" errors as outOfWindow', async () => {
    await ch.sendNotification('old');
    api.deleteMessageErrors.push(new Error("telegram: Bad Request: message can't be deleted"));
    const r = await ch.clearLastMessages(1);
    expect(r.outOfWindow).toBe(1);
    expect(r.deleted).toBe(0);
  });

  it('dryRun reports counts without calling deleteMessage', async () => {
    await ch.sendNotification('a');
    const r = await ch.clearLastMessages(1, { dryRun: true });
    expect(r).toEqual({ attempted: 1, deleted: 0, outOfWindow: 0 });
    expect(api.deleteMessageCalls).toHaveLength(0);
  });

  it('non-positive n is a no-op', async () => {
    await ch.sendNotification('a');
    const r = await ch.clearLastMessages(0);
    expect(r).toEqual({ attempted: 0, deleted: 0, outOfWindow: 0 });
  });

  it('drops successfully-deleted ids from the tracker so a second call does not retry', async () => {
    await ch.sendNotification('a');
    await ch.sendNotification('b');
    await ch.clearLastMessages(2);
    const tracker = (ch as unknown as { sentMessages: unknown[] }).sentMessages;
    expect(tracker).toHaveLength(0);
    const r2 = await ch.clearLastMessages(2);
    expect(r2.attempted).toBe(0);
  });
});
