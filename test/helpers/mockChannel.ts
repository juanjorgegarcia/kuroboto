import type {
  Channel,
  ChannelEventHandlers,
  ChannelEventName,
} from '../../src/channels/Channel.js';
import type { PromptRequest, Decision } from '../../src/core/types.js';

export class MockChannel implements Channel {
  public sentNotifications: string[] = [];
  public sentPrompts: PromptRequest[] = [];
  public throwOnSendPrompt = false;
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

  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void {
    this.handlers[event].push(handler);
  }

  emitDecision(requestId: string, decision: Decision): void {
    for (const h of this.handlers.decision) h({ requestId, decision });
  }
}

export const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
