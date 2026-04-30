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
  ClearTopicsResult,
  ClearMessagesResult,
} from '../Channel.js';
import {
  TelegramApi,
  isThreadNotFoundError,
  type TelegramUpdate,
  type InlineKeyboardButton,
} from './api.js';
import { Poller } from './poller.js';
import { TopicManager, pickTopicKey } from './topics.js';

/** Telegram refuses bot deleteMessage on messages older than 48 hours. */
const BOT_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Cap how many outbound message IDs we keep for chat clear. */
const SENT_MESSAGE_RING_SIZE = 1000;

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
  /** Ring buffer of outbound message ids — used by chat clear. Newest last. */
  private readonly sentMessages: Array<{ messageId: number; sentAt: number }> = [];

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

  topicStats(): { forumMode: boolean; count: number } {
    return {
      forumMode: this.topicManager?.forumMode ?? false,
      count: this.topicManager?.size() ?? 0,
    };
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
    let messageId: number;
    if (!this.topicManager) {
      messageId = await send(undefined);
    } else {
      const { key, name } = pickTopicKey(ctx);
      const threadId = await this.topicManager.resolve(key, name);
      try {
        messageId = await send(threadId);
      } catch (e) {
        if (!isThreadNotFoundError(e)) throw e;
        this.opts.logger.warn('topic missing, purging and recreating', { key });
        await this.topicManager.purge(key);
        const newId = await this.topicManager.resolve(key, name);
        messageId = await send(newId);
      }
    }
    this.recordSent(messageId);
    return messageId;
  }

  private recordSent(messageId: number): void {
    this.sentMessages.push({ messageId, sentAt: Date.now() });
    if (this.sentMessages.length > SENT_MESSAGE_RING_SIZE) {
      this.sentMessages.splice(0, this.sentMessages.length - SENT_MESSAGE_RING_SIZE);
    }
  }

  async clearTopics(opts: {
    keys?: string[];
    all?: boolean;
    except?: string[];
    dryRun?: boolean;
  }): Promise<ClearTopicsResult> {
    if (!this.topicManager) {
      throw new Error('forumMode is off — use `kuroboto chat clear` instead');
    }
    const except = new Set(opts.except ?? []);
    let targets: Array<{ key: string; threadId: number }>;
    if (opts.all) {
      targets = this.topicManager.entries().filter((e) => !except.has(e.key));
    } else {
      targets = (opts.keys ?? [])
        .map((k) => {
          const threadId = this.topicManager!.get(k);
          return threadId === undefined ? null : { key: k, threadId };
        })
        .filter((x): x is { key: string; threadId: number } => x !== null);
    }
    const cleared: string[] = [];
    const failed: Array<{ key: string; error: string }> = [];
    if (opts.dryRun) {
      return { cleared: targets.map((t) => t.key), failed: [] };
    }
    for (const t of targets) {
      try {
        await this.api.deleteForumTopic(this.opts.chatId, t.threadId);
        await this.topicManager.purge(t.key);
        cleared.push(t.key);
      } catch (e) {
        const err = (e as Error).message;
        // Telegram already lost the topic? Purge our cache so it doesn't keep
        // pointing at a dead thread.
        if (isThreadNotFoundError(e)) {
          await this.topicManager.purge(t.key).catch(() => {});
          cleared.push(t.key);
        } else {
          failed.push({ key: t.key, error: err });
        }
      }
    }
    return { cleared, failed };
  }

  async clearLastMessages(n: number, opts: { dryRun?: boolean } = {}): Promise<ClearMessagesResult> {
    if (n <= 0) return { attempted: 0, deleted: 0, outOfWindow: 0 };
    const slice = this.sentMessages.slice(-n);
    if (opts.dryRun) {
      const cutoff = Date.now() - BOT_DELETE_WINDOW_MS;
      const outOfWindow = slice.filter((m) => m.sentAt < cutoff).length;
      return { attempted: slice.length, deleted: 0, outOfWindow };
    }
    const cutoff = Date.now() - BOT_DELETE_WINDOW_MS;
    let deleted = 0;
    let outOfWindow = 0;
    const survivors: number[] = [];
    for (const m of slice) {
      if (m.sentAt < cutoff) {
        outOfWindow += 1;
        continue;
      }
      try {
        await this.api.deleteMessage(this.opts.chatId, m.messageId);
        deleted += 1;
      } catch (e) {
        const msg = (e as Error).message;
        if (/can't be deleted|message to delete not found/i.test(msg)) {
          outOfWindow += 1;
        } else {
          survivors.push(m.messageId);
          this.opts.logger.warn('deleteMessage failed', { messageId: m.messageId, err: msg });
        }
      }
    }
    // Drop deleted ids from the tracker so a second `chat clear --last N` does
    // not re-attempt them.
    for (const m of slice) {
      const stillTracked = survivors.includes(m.messageId);
      if (stillTracked) continue;
      const idx = this.sentMessages.findIndex((s) => s.messageId === m.messageId);
      if (idx >= 0) this.sentMessages.splice(idx, 1);
    }
    return { attempted: slice.length, deleted, outOfWindow };
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
