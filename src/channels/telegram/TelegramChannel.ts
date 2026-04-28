import type {
  PromptRequest,
  DecisionEvent,
  FreeTextEvent,
  Decision,
} from '../../core/types.js';
import type { Logger } from '../../core/logger.js';
import type { Channel, ChannelEventName, ChannelEventHandlers } from '../Channel.js';
import { TelegramApi, type TelegramUpdate, type InlineKeyboardButton } from './api.js';
import { Poller } from './poller.js';

export interface TelegramChannelOptions {
  token: string;
  chatId: number;
  logger: Logger;
}

export class TelegramChannel implements Channel {
  private readonly api: TelegramApi;
  private readonly poller: Poller;
  private readonly handlers = {
    decision: [] as Array<(event: DecisionEvent) => void>,
    freeText: [] as Array<(event: FreeTextEvent) => void>,
  };
  private readonly promptMessageIds = new Map<string, { messageId: number; chatId: number }>();
  private awaitingNoteFor: string | null = null;

  constructor(private readonly opts: TelegramChannelOptions) {
    this.api = new TelegramApi(opts.token);
    this.poller = new Poller({
      api: this.api,
      chatId: opts.chatId,
      logger: opts.logger,
      onUpdate: (u) => this.handleUpdate(u),
    });
  }

  async start(): Promise<void> {
    this.poller.start();
    this.opts.logger.info('telegram channel started');
  }

  async stop(): Promise<void> {
    await this.poller.stop();
    this.opts.logger.info('telegram channel stopped');
  }

  async sendNotification(text: string): Promise<void> {
    await this.api.sendMessage(this.opts.chatId, text);
  }

  async sendPrompt(req: PromptRequest): Promise<void> {
    const keyboard = buildKeyboard(req);
    const messageId = await this.api.sendMessage(this.opts.chatId, req.text, keyboard);
    this.promptMessageIds.set(req.requestId, { messageId, chatId: this.opts.chatId });
  }

  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void {
    this.handlers[event].push(handler as never);
  }

  private handleUpdate(update: TelegramUpdate): void {
    if (update.callback_query) {
      const { id: callbackId, data } = update.callback_query;
      this.api.answerCallbackQuery(callbackId).catch((e) => {
        this.opts.logger.warn('answerCallbackQuery failed', { err: (e as Error).message });
      });
      const parsed = parseCallbackData(data);
      if (!parsed) {
        this.opts.logger.warn('unparseable callback_data');
        return;
      }
      if (parsed.action === 'deny_note') {
        this.awaitingNoteFor = parsed.requestId;
        this.editKeyboardToAwaitingNote(parsed.requestId);
        return;
      }
      const decision = decisionFromAction(parsed.action);
      if (decision) {
        this.clearKeyboard(parsed.requestId);
        for (const h of this.handlers.decision) h({ requestId: parsed.requestId, decision });
      }
      return;
    }
    if (update.message?.text) {
      const text = update.message.text.trim();
      if (this.awaitingNoteFor) {
        const requestId = this.awaitingNoteFor;
        this.awaitingNoteFor = null;
        this.clearKeyboard(requestId);
        for (const h of this.handlers.decision) {
          h({ requestId, decision: { decision: 'deny', reason: text } });
        }
        return;
      }
      for (const h of this.handlers.freeText) h({ text });
    }
  }

  private editKeyboardToAwaitingNote(requestId: string): void {
    const ref = this.promptMessageIds.get(requestId);
    if (!ref) return;
    this.api.editMessageReplyMarkup(ref.chatId, ref.messageId, [
      [{ text: '✏️ aguardando justificativa…', callback_data: `${requestId}:noop` }],
    ]).catch((e) => {
      this.opts.logger.debug('editMessageReplyMarkup (note) failed', { err: (e as Error).message });
    });
  }

  private clearKeyboard(requestId: string): void {
    const ref = this.promptMessageIds.get(requestId);
    if (!ref) return;
    this.promptMessageIds.delete(requestId);
    this.api.editMessageReplyMarkup(ref.chatId, ref.messageId, null).catch((e) => {
      this.opts.logger.debug('editMessageReplyMarkup failed', { err: (e as Error).message });
    });
  }
}

function buildKeyboard(req: PromptRequest): InlineKeyboardButton[][] {
  return [
    req.buttons.map((b) => ({
      text: b.label,
      callback_data: `${req.requestId}:${b.action}`,
    })),
  ];
}

function parseCallbackData(data: string): { requestId: string; action: string } | null {
  const idx = data.lastIndexOf(':');
  if (idx <= 0) return null;
  return {
    requestId: data.slice(0, idx),
    action: data.slice(idx + 1),
  };
}

function decisionFromAction(action: string): Decision | null {
  if (action === 'allow') return { decision: 'allow' };
  if (action === 'allow_remember') return { decision: 'allow', remember: true };
  if (action === 'deny') return { decision: 'deny' };
  return null;
}
