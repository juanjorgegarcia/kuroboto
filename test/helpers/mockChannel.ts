import type {
  Channel,
  ChannelContext,
  ChannelEventHandlers,
  ChannelEventName,
  ClearTopicsResult,
  ClearMessagesResult,
} from '../../src/channels/Channel.js';
import type { PromptRequest, QuestionRequest, Decision } from '../../src/core/types.js';

interface SentNotification {
  text: string;
  ctx?: ChannelContext;
}

interface SentPrompt {
  req: PromptRequest;
  ctx?: ChannelContext;
}

interface SentQuestion {
  req: QuestionRequest;
  ctx?: ChannelContext;
}

export class MockChannel implements Channel {
  public sentNotificationsDetailed: SentNotification[] = [];
  public sentPromptsDetailed: SentPrompt[] = [];
  public sentQuestionsDetailed: SentQuestion[] = [];
  public throwOnSendPrompt = false;
  public throwOnSendQuestion = false;
  private nextSentMessageId = 1000;
  private handlers: { [K in ChannelEventName]: Array<ChannelEventHandlers[K]> } = {
    decision: [],
    freeText: [],
  };

  /** Back-compat shorthand used by older tests — text array. */
  get sentNotifications(): string[] {
    return this.sentNotificationsDetailed.map((n) => n.text);
  }

  /** Back-compat shorthand used by older tests — prompt requests. */
  get sentPrompts(): PromptRequest[] {
    return this.sentPromptsDetailed.map((p) => p.req);
  }

  /** Back-compat shorthand used by older tests — question requests. */
  get sentQuestions(): QuestionRequest[] {
    return this.sentQuestionsDetailed.map((q) => q.req);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendNotification(text: string, ctx?: ChannelContext): Promise<void> {
    this.sentNotificationsDetailed.push({ text, ctx });
  }

  async sendPrompt(req: PromptRequest, ctx?: ChannelContext): Promise<void> {
    if (this.throwOnSendPrompt) throw new Error('mock channel error');
    this.sentPromptsDetailed.push({ req, ctx });
  }

  async sendQuestion(
    req: QuestionRequest,
    ctx?: ChannelContext,
  ): Promise<{ sentMessageId: string }> {
    if (this.throwOnSendQuestion) throw new Error('mock channel error');
    this.sentQuestionsDetailed.push({ req, ctx });
    return { sentMessageId: String(this.nextSentMessageId++) };
  }

  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void {
    this.handlers[event].push(handler);
  }

  /** Stub config — set by tests to make clearTopics / clearLastMessages testable. */
  public clearTopicsImpl: ((opts: { keys?: string[]; all?: boolean; except?: string[]; dryRun?: boolean }) => Promise<ClearTopicsResult>) | undefined;
  public clearLastMessagesImpl: ((n: number, opts?: { dryRun?: boolean }) => Promise<ClearMessagesResult>) | undefined;
  public clearTopicsCalls: Array<{ keys?: string[]; all?: boolean; except?: string[]; dryRun?: boolean }> = [];
  public clearLastMessagesCalls: Array<{ n: number; dryRun?: boolean }> = [];

  async clearTopics(opts: { keys?: string[]; all?: boolean; except?: string[]; dryRun?: boolean }): Promise<ClearTopicsResult> {
    this.clearTopicsCalls.push(opts);
    if (this.clearTopicsImpl) return this.clearTopicsImpl(opts);
    return { cleared: opts.keys ?? [], failed: [] };
  }

  async clearLastMessages(n: number, opts: { dryRun?: boolean } = {}): Promise<ClearMessagesResult> {
    this.clearLastMessagesCalls.push({ n, dryRun: opts.dryRun });
    if (this.clearLastMessagesImpl) return this.clearLastMessagesImpl(n, opts);
    return { attempted: n, deleted: n, outOfWindow: 0 };
  }

  emitDecision(requestId: string, decision: Decision): void {
    for (const h of this.handlers.decision) h({ requestId, decision });
  }

  emitFreeText(text: string, replyToMessageId?: string): void {
    for (const h of this.handlers.freeText) h({ text, replyToMessageId });
  }
}

export const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
