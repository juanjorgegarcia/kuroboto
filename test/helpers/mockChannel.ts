import type {
  Channel,
  ChannelEventHandlers,
  ChannelEventName,
} from '../../src/channels/Channel.js';
import type { PromptRequest, QuestionRequest, Decision } from '../../src/core/types.js';

export class MockChannel implements Channel {
  public sentNotifications: string[] = [];
  public sentPrompts: PromptRequest[] = [];
  public sentQuestions: QuestionRequest[] = [];
  public throwOnSendPrompt = false;
  public throwOnSendQuestion = false;
  private nextSentMessageId = 1000;
  private handlers: { [K in ChannelEventName]: Array<ChannelEventHandlers[K]> } = {
    decision: [],
    freeText: [],
  };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendNotification(text: string): Promise<void> {
    this.sentNotifications.push(text);
  }

  async sendPrompt(req: PromptRequest): Promise<void> {
    if (this.throwOnSendPrompt) throw new Error('mock channel error');
    this.sentPrompts.push(req);
  }

  async sendQuestion(req: QuestionRequest): Promise<{ sentMessageId: string }> {
    if (this.throwOnSendQuestion) throw new Error('mock channel error');
    this.sentQuestions.push(req);
    return { sentMessageId: String(this.nextSentMessageId++) };
  }

  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void {
    this.handlers[event].push(handler);
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
