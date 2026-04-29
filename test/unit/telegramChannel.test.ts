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
