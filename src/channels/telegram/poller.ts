import type { Logger } from '../../core/logger.js';
import { TelegramApi, type TelegramUpdate } from './api.js';

export function updateBelongsToChat(update: TelegramUpdate, chatId: number): boolean {
  if (update.message) return update.message.chat.id === chatId;
  if (update.callback_query) {
    return (
      update.callback_query.from.id === chatId &&
      update.callback_query.message.chat.id === chatId
    );
  }
  return false;
}

const POLL_TIMEOUT_SEC = 25;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface PollerOptions {
  api: TelegramApi;
  chatId: number;
  logger: Logger;
  onUpdate(update: TelegramUpdate): void;
}

export class Poller {
  private running = false;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private offset = 0;

  constructor(private readonly opts: PollerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {
        // swallow — abort throws AbortError
      });
    }
  }

  private async loop(): Promise<void> {
    let backoff = BACKOFF_INITIAL_MS;
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const updates = await this.opts.api.getUpdates(
          this.offset,
          POLL_TIMEOUT_SEC,
          this.abortController.signal,
        );
        backoff = BACKOFF_INITIAL_MS;
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (!updateBelongsToChat(update, this.opts.chatId)) continue;
          try {
            this.opts.onUpdate(update);
          } catch (e) {
            this.opts.logger.error('onUpdate handler threw', { err: (e as Error).message });
          }
        }
      } catch (e) {
        if (!this.running) break;
        const err = e as Error;
        if (err.name === 'AbortError') break;
        this.opts.logger.warn('poll error, backing off', { err: err.message, backoff });
        await sleep(backoff, this.abortController.signal).catch(() => {});
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    }
  });
}
