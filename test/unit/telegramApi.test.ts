import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramApi, isThreadNotFoundError } from '../../src/channels/telegram/api.js';

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function captureFetch(responder: (req: CapturedRequest) => Response | Promise<Response>): {
  calls: CapturedRequest[];
  restore: () => void;
} {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { url: typeof input === 'string' ? input : input.toString(), init };
    calls.push(req);
    return responder(req);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TelegramApi.sendMessage', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('includes message_thread_id when messageThreadId is provided', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true, result: { message_id: 7 } }));
    restore = cap.restore;
    const api = new TelegramApi('TKN');
    const id = await api.sendMessage(123, 'hi', { messageThreadId: 42 });
    expect(id).toBe(7);
    expect(cap.calls).toHaveLength(1);
    const body = JSON.parse(String(cap.calls[0].init?.body));
    expect(body.message_thread_id).toBe(42);
    expect(body.chat_id).toBe(123);
    expect(body.text).toBe('hi');
  });

  it('omits message_thread_id when messageThreadId is undefined', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true, result: { message_id: 7 } }));
    restore = cap.restore;
    const api = new TelegramApi('TKN');
    await api.sendMessage(123, 'hi');
    const body = JSON.parse(String(cap.calls[0].init?.body));
    expect('message_thread_id' in body).toBe(false);
  });

  it('throws ChannelError including telegram description on 4xx', async () => {
    const cap = captureFetch(() =>
      jsonResponse({ ok: false, description: 'Bad Request: message thread not found' }, 400),
    );
    restore = cap.restore;
    const api = new TelegramApi('TKN');
    await expect(api.sendMessage(123, 'hi', { messageThreadId: 99 })).rejects.toThrow(
      /message thread not found/,
    );
  });
});

describe('TelegramApi.createForumTopic', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('returns message_thread_id from result', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true, result: { message_thread_id: 99 } }));
    restore = cap.restore;
    const api = new TelegramApi('TKN');
    const id = await api.createForumTopic(-100123, 'fix-bot-ux');
    expect(id).toBe(99);
    const body = JSON.parse(String(cap.calls[0].init?.body));
    expect(body).toEqual({ chat_id: -100123, name: 'fix-bot-ux' });
  });

  it('throws on telegram error', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: false, description: 'CHAT_NOT_FOUND' }, 400));
    restore = cap.restore;
    const api = new TelegramApi('TKN');
    await expect(api.createForumTopic(-1, 'x')).rejects.toThrow(/CHAT_NOT_FOUND/);
  });
});

describe('TelegramApi.getMe', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('returns the bot id', async () => {
    const cap = captureFetch(() =>
      jsonResponse({ ok: true, result: { id: 12345, is_bot: true, username: 'bot' } }),
    );
    restore = cap.restore;
    const api = new TelegramApi('TKN');
    const me = await api.getMe();
    expect(me).toEqual({ id: 12345 });
  });
});

describe('TelegramApi.getChatMember', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('returns status and can_manage_topics', async () => {
    const cap = captureFetch(() =>
      jsonResponse({
        ok: true,
        result: { status: 'administrator', can_manage_topics: true },
      }),
    );
    restore = cap.restore;
    const api = new TelegramApi('TKN');
    const member = await api.getChatMember(-100, 42);
    expect(member.status).toBe('administrator');
    expect(member.can_manage_topics).toBe(true);
    const body = JSON.parse(String(cap.calls[0].init?.body));
    expect(body).toEqual({ chat_id: -100, user_id: 42 });
  });
});

describe('isThreadNotFoundError', () => {
  it('matches the telegram description case-insensitively', () => {
    expect(isThreadNotFoundError(new Error('telegram: Bad Request: MESSAGE THREAD NOT FOUND'))).toBe(true);
    expect(isThreadNotFoundError(new Error('telegram: message thread not found'))).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isThreadNotFoundError(new Error('something else'))).toBe(false);
    expect(isThreadNotFoundError('not an error')).toBe(false);
    expect(isThreadNotFoundError(undefined)).toBe(false);
  });
});
