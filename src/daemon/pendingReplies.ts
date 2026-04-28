// In-memory tracker for outstanding Q&A prompts awaiting a Telegram reply.
// Mirrors `pending.ts` (permission requests) but keys by the Telegram
// `sentMessageId` of the bot's outbound question, since that's what arrives
// on incoming replies via `reply_to_message.message_id`.

export interface PendingReplyHandle {
  promise: Promise<string>;
}

interface Entry {
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

export class PendingReplies {
  private readonly entries = new Map<string, Entry>();

  create(sentMessageId: string, timeoutMs: number): PendingReplyHandle {
    let resolve!: (text: string) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      const entry = this.entries.get(sentMessageId);
      if (entry) {
        this.entries.delete(sentMessageId);
        entry.reject(new Error('timeout'));
      }
    }, timeoutMs);
    this.entries.set(sentMessageId, { resolve, reject, timer, createdAt: Date.now() });
    return { promise };
  }

  resolveBySentMessageId(sentMessageId: string, text: string): boolean {
    const entry = this.entries.get(sentMessageId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(sentMessageId);
    entry.resolve(text);
    return true;
  }

  cancelAll(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('shutdown'));
    }
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
