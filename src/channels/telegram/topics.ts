import fsp from 'node:fs/promises';
import type { Logger } from '../../core/logger.js';

export type TopicAuditSource =
  | 'topic-created'
  | 'topic-create-failed'
  | 'topic-purged';

export interface TopicAuditEvent {
  source: TopicAuditSource;
  key: string;
  name?: string;
  threadId?: number;
  error?: string;
}

export interface TopicManagerApi {
  createForumTopic(chatId: number, name: string): Promise<number>;
}

export interface TopicManagerOptions {
  api: TopicManagerApi;
  chatId: number;
  forumMode: boolean;
  storagePath: string;
  logger: Logger;
  audit?: (event: TopicAuditEvent) => void;
}

/**
 * Maps logical session keys (CLI slug, sleep slug, "kuroboto-system", etc.)
 * to Telegram forum `message_thread_id` values, with on-disk persistence so
 * daemon restarts don't recreate topics. Lazy: a topic isn't created until the
 * first outbound message for its key fires through `resolve()`.
 *
 * When `forumMode: false`, `resolve()` is a no-op returning `undefined` —
 * messages flow into the main chat as in the original DM behavior.
 */
export class TopicManager {
  private readonly cache = new Map<string, number>();
  private loaded = false;
  /**
   * Serializes createForumTopic calls per-key so two concurrent resolves for
   * the same key wait on a single API request and reuse its thread id.
   */
  private readonly inflight = new Map<string, Promise<number | undefined>>();

  constructor(private readonly opts: TopicManagerOptions) {}

  async loadFromDisk(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await fsp.readFile(this.opts.storagePath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.opts.logger.warn('topics.json read failed', {
        err: (e as Error).message,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.opts.logger.warn('topics.json malformed, starting empty', {
        err: (e as Error).message,
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.opts.logger.warn('topics.json malformed, starting empty');
      return;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.cache.set(key, value);
      }
    }
  }

  /**
   * Resolve a key to its forum thread id. Returns `undefined` when forumMode
   * is off, when topic creation fails (so callers post to the main chat), or
   * when no cached entry exists and `name` is omitted.
   */
  async resolve(key: string, name: string): Promise<number | undefined> {
    if (!this.opts.forumMode) return undefined;
    if (!this.loaded) await this.loadFromDisk();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.createAndPersist(key, name).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async createAndPersist(key: string, name: string): Promise<number | undefined> {
    let threadId: number;
    try {
      threadId = await this.opts.api.createForumTopic(this.opts.chatId, name);
    } catch (e) {
      const msg = (e as Error).message;
      this.opts.logger.warn('createForumTopic failed', { key, err: msg });
      this.opts.audit?.({ source: 'topic-create-failed', key, name, error: msg });
      return undefined;
    }
    this.cache.set(key, threadId);
    await this.flushToDisk();
    this.opts.audit?.({ source: 'topic-created', key, name, threadId });
    return threadId;
  }

  /**
   * Drop a key from cache + disk. Used when the daemon learns a topic was
   * deleted client-side (Telegram returns `message thread not found`).
   */
  async purge(key: string): Promise<void> {
    if (!this.cache.delete(key)) return;
    await this.flushToDisk();
    this.opts.audit?.({ source: 'topic-purged', key });
  }

  private async flushToDisk(): Promise<void> {
    const obj: Record<string, number> = {};
    for (const [k, v] of this.cache) obj[k] = v;
    try {
      await fsp.writeFile(this.opts.storagePath, JSON.stringify(obj, null, 2), {
        mode: 0o600,
      });
    } catch (e) {
      this.opts.logger.warn('topics.json write failed', {
        err: (e as Error).message,
      });
    }
  }
}
