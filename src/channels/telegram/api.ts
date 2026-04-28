import { ChannelError } from '../../core/errors.js';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; is_bot: boolean; first_name?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { message_id: number; chat: { id: number } };
    data: string;
  };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async getUpdates(offset: number, timeoutSec: number, abort?: AbortSignal): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: String(timeoutSec),
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    });
    const res = await fetch(`${this.url('getUpdates')}?${params}`, { signal: abort });
    if (!res.ok) {
      throw new ChannelError(`getUpdates HTTP ${res.status}`);
    }
    const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[]; description?: string };
    if (!json.ok) {
      throw new ChannelError(`telegram: ${json.description ?? 'unknown error'}`);
    }
    return json.result;
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts?: { keyboard?: InlineKeyboardButton[][]; forceReply?: boolean; timeoutMs?: number },
  ): Promise<number> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (opts?.keyboard) {
        body.reply_markup = { inline_keyboard: opts.keyboard };
      } else if (opts?.forceReply) {
        // force_reply opens an input box on the user's client with the bot's
        // message quoted above. Telegram returns the user's reply with
        // reply_to_message.message_id pointing at this message.
        body.reply_markup = { force_reply: true };
      }
      const res = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ChannelError(`sendMessage HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        ok: boolean;
        result?: { message_id: number };
        description?: string;
      };
      if (!json.ok || !json.result) {
        throw new ChannelError(`telegram: ${json.description ?? 'unknown error'}`);
      }
      return json.result.message_id;
    } finally {
      clearTimeout(timer);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, timeoutMs = 5_000): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
      if (text) body.text = text;
      const res = await fetch(this.url('answerCallbackQuery'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ChannelError(`answerCallbackQuery HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    keyboard: InlineKeyboardButton[][] | null,
    timeoutMs = 5_000,
  ): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      };
      const res = await fetch(this.url('editMessageReplyMarkup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok && res.status !== 400) {
        // 400 commonly means "message is not modified" — safe to ignore
        throw new ChannelError(`editMessageReplyMarkup HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
