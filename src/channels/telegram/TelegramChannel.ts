import type {
  PromptRequest,
  QuestionRequest,
  DecisionEvent,
  FreeTextEvent,
  Decision,
} from '../../core/types.js';
import type { Logger } from '../../core/logger.js';
import type {
  Channel,
  ChannelContext,
  ChannelEventName,
  ChannelEventHandlers,
} from '../Channel.js';
import {
  TelegramApi,
  isThreadNotFoundError,
  type TelegramUpdate,
  type InlineKeyboardButton,
} from './api.js';
import { Poller } from './poller.js';
import { TopicManager, pickTopicKey } from './topics.js';

export interface TelegramChannelOptions {
  token: string;
  chatId: number;
  logger: Logger;
  topicManager?: TopicManager;
}

export class TelegramChannel implements Channel {
  private readonly api: TelegramApi;
  private readonly poller: Poller;
  private readonly topicManager?: TopicManager;
  private readonly handlers = {
    decision: [] as Array<(event: DecisionEvent) => void>,
    freeText: [] as Array<(event: FreeTextEvent) => void>,
  };
  private readonly promptMessageIds = new Map<string, { messageId: number; chatId: number }>();
  private awaitingNoteFor: string | null = null;

  constructor(private readonly opts: TelegramChannelOptions) {
    this.api = new TelegramApi(opts.token);
    this.topicManager = opts.topicManager;
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

  async sendNotification(text: string, ctx?: ChannelContext): Promise<void> {
    await this.sendInTopic(ctx, (threadId) =>
      this.api.sendMessage(this.opts.chatId, text, { messageThreadId: threadId }),
    );
  }

  async sendPrompt(req: PromptRequest, ctx?: ChannelContext): Promise<void> {
    const keyboard = buildKeyboard(req);
    const messageId = await this.sendInTopic(ctx, (threadId) =>
      this.api.sendMessage(this.opts.chatId, req.text, { keyboard, messageThreadId: threadId }),
    );
    this.promptMessageIds.set(req.requestId, { messageId, chatId: this.opts.chatId });
  }

  async sendQuestion(req: QuestionRequest, ctx?: ChannelContext): Promise<{ sentMessageId: string }> {
    const messageId = await this.sendInTopic(ctx, (threadId) =>
      this.api.sendMessage(this.opts.chatId, req.text, {
        forceReply: req.forceReply ?? true,
        messageThreadId: threadId,
      }),
    );
    return { sentMessageId: String(messageId) };
  }

  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void {
    this.handlers[event].push(handler as never);
  }

  /**
   * Resolve the routing context to a thread id, run `send`, and on a
   * "message thread not found" 400 — meaning the topic was deleted in
   * the client — purge the cached entry and retry once with a fresh
   * topic. When forumMode is off (no topicManager), `send` is invoked
   * directly with `undefined` so the message lands in the main chat.
   */
  private async sendInTopic(
    ctx: ChannelContext | undefined,
    send: (threadId: number | undefined) => Promise<number>,
  ): Promise<number> {
    if (!this.topicManager) return send(undefined);
    const { key, name } = pickTopicKey(ctx);
    const threadId = await this.topicManager.resolve(key, name);
    try {
      return await send(threadId);
    } catch (e) {
      if (!isThreadNotFoundError(e)) throw e;
      this.opts.logger.warn('topic missing, purging and recreating', { key });
      await this.topicManager.purge(key);
      const newId = await this.topicManager.resolve(key, name);
      return send(newId);
    }
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
      const replyToMessageId = update.message.reply_to_message?.message_id;
      // A reply_to_message means the user used Telegram's Reply UI — almost
      // certainly answering a Q&A prompt, so route it as freeText with the
      // correlation id and skip the deny_note interception (Q&A and deny_note
      // can be in flight simultaneously, but only Q&A uses replies).
      if (replyToMessageId !== undefined) {
        for (const h of this.handlers.freeText) {
          h({ text, replyToMessageId: String(replyToMessageId) });
        }
        return;
      }
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
