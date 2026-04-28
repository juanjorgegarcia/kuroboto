import type { PromptRequest, DecisionEvent, FreeTextEvent } from '../core/types.js';

export type ChannelEventName = 'decision' | 'freeText';

export type ChannelEventHandlers = {
  decision: (event: DecisionEvent) => void;
  freeText: (event: FreeTextEvent) => void;
};

export interface Channel {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendPrompt(req: PromptRequest): Promise<void>;
  sendNotification(text: string): Promise<void>;
  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void;
}
