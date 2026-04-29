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

/**
 * Routing context for outbound messages. The channel implementation chooses
 * where to deliver based on this — TelegramChannel uses it to pick a forum
 * topic when forumMode is on; in DM mode it's ignored. Callers populate it
 * from the source of the event (hook payload, sleep slug, system event).
 */
export interface ChannelContext {
  /**
   * Logical session key — Spec E client slug, sleep slug, or any other
   * stable identity. Becomes the forum topic key directly.
   */
  slug?: string;
  /** When true, `slug` refers to a sleep session and the topic name is prefixed with 💤. */
  isSleep?: boolean;
  /** Bare claude `session_id` used when no slug is available (direct `claude` invocation). */
  sessionId?: string;
  /** Used together with `sessionId` to derive a friendly topic name (`<basename>-<sid8>`). */
  cwdBasename?: string;
  /** Daemon lifecycle / channel-error notifications — routed to the kuroboto-system topic. */
  system?: boolean;
}

export interface ClearTopicsResult {
  /** Topic keys that were successfully cleared. */
  cleared: string[];
  /** Topic keys that errored out (Telegram refused, network, etc.). */
  failed: Array<{ key: string; error: string }>;
}

export interface ClearMessagesResult {
  /** Messages the daemon attempted to delete. */
  attempted: number;
  /** Successfully deleted messages. */
  deleted: number;
  /** Messages outside the 48h bot delete window — Telegram refuses these. */
  outOfWindow: number;
}

export interface Channel {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendPrompt(req: PromptRequest, ctx?: ChannelContext): Promise<void>;
  sendNotification(text: string, ctx?: ChannelContext): Promise<void>;
  /** Send a Q&A question that opens a Reply UI; returns the channel-specific
   *  message id used to correlate the user's reply back to this question. */
  sendQuestion(req: QuestionRequest, ctx?: ChannelContext): Promise<{ sentMessageId: string }>;
  on<K extends ChannelEventName>(event: K, handler: ChannelEventHandlers[K]): void;
  /**
   * Clear forum topics by key (or all of them, except optional preserved keys).
   * Implementations without a forum surface (DM mode) reject the request.
   */
  clearTopics?(opts: { keys?: string[]; all?: boolean; except?: string[]; dryRun?: boolean }): Promise<ClearTopicsResult>;
  /** Delete the last N outbound messages tracked by the channel. */
  clearLastMessages?(n: number, opts?: { dryRun?: boolean }): Promise<ClearMessagesResult>;
}
