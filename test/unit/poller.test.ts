import { describe, it, expect } from 'vitest';
import { updateBelongsToChat } from '../../src/channels/telegram/poller.js';
import type { TelegramUpdate } from '../../src/channels/telegram/api.js';

const MY_CHAT = 100;
const OTHER_CHAT = 999;

describe('updateBelongsToChat', () => {
  it('accepts message from configured chat', () => {
    const u: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: MY_CHAT, is_bot: false },
        chat: { id: MY_CHAT, type: 'private' },
        date: 0,
        text: 'hi',
      },
    };
    expect(updateBelongsToChat(u, MY_CHAT)).toBe(true);
  });

  it('rejects message from foreign chat', () => {
    const u: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: OTHER_CHAT, is_bot: false },
        chat: { id: OTHER_CHAT, type: 'private' },
        date: 0,
        text: 'hi',
      },
    };
    expect(updateBelongsToChat(u, MY_CHAT)).toBe(false);
  });

  it('accepts callback_query when both from.id and message.chat.id match', () => {
    const u: TelegramUpdate = {
      update_id: 3,
      callback_query: {
        id: 'c1',
        from: { id: MY_CHAT },
        message: { message_id: 99, chat: { id: MY_CHAT } },
        data: 'req:allow',
      },
    };
    expect(updateBelongsToChat(u, MY_CHAT)).toBe(true);
  });

  it('rejects callback_query when from.id is foreign', () => {
    const u: TelegramUpdate = {
      update_id: 4,
      callback_query: {
        id: 'c2',
        from: { id: OTHER_CHAT },
        message: { message_id: 99, chat: { id: MY_CHAT } },
        data: 'req:allow',
      },
    };
    expect(updateBelongsToChat(u, MY_CHAT)).toBe(false);
  });

  it('rejects empty updates', () => {
    expect(updateBelongsToChat({ update_id: 5 }, MY_CHAT)).toBe(false);
  });
});
