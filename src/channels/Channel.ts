import type {
  PromptRequest,
  QuestionRequest,
  DecisionEvent,
  FreeTextEvent,
} from '../core/types.js';

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
  /** Send a Q&A question that opens a Reply UI; returns the channel-specific
   *  message id used to correlate the user's reply back to this question. */
  sendQuestion(req: QuestionRequest): Promise<{ sentMessageId: string }>;
  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void;
}
