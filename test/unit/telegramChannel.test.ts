import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramChannel } from '../../src/channels/telegram/TelegramChannel.js';
import type { Decision } from '../../src/core/types.js';
import { noopLogger } from '../helpers/mockChannel.js';

class FakeApi {
  public messages: Array<{ chatId: number; text: string; keyboard?: unknown }> = [];
  public callbacksAnswered: string[] = [];
  public editKeyboardCalls: Array<{ messageId: number; keyboard: unknown }> = [];
  private nextMessageId = 100;
  async sendMessage(chatId: number, text: string, keyboard?: unknown): Promise<number> {
    this.messages.push({ chatId, text, keyboard });
    return this.nextMessageId++;
  }
  async answerCallbackQuery(id: string): Promise<void> {
    this.callbacksAnswered.push(id);
  }
  async editMessageReplyMarkup(_chat: number, messageId: number, keyboard: unknown): Promise<void> {
    this.editKeyboardCalls.push({ messageId, keyboard });
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
