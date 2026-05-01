import { randomUUID } from 'node:crypto';
import type { Decision } from '../core/types.js';

export interface PendingEntry {
  requestId: string;
  resolve: (d: Decision) => void;
  timeoutHandle: NodeJS.Timeout;
  createdAt: number;
}

export class PendingMap {
  private readonly entries = new Map<string, PendingEntry>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 10_000);
  }

  stopCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  create(timeoutMs: number): { requestId: string; promise: Promise<Decision> } {
    const requestId = randomUUID();
    let resolveFn: (d: Decision) => void = () => {};
    const promise = new Promise<Decision>((res) => {
      resolveFn = res;
    });
    const timeoutHandle = setTimeout(() => {
      const e = this.entries.get(requestId);
      if (e) {
        this.entries.delete(requestId);
        // Resolve as 'ask' (not 'deny') so the hook surfaces no decision and
        // Claude Code falls back to its native permission UI. Denying on
        // timeout used to surface as "PreToolUse hook blocking error: timeout"
        // — confusing for desk users who simply hadn't seen the Telegram
        // prompt yet. Remote workflow is unaffected: replies arriving inside
        // the window still hit `resolve()` with the real decision.
        e.resolve({ decision: 'ask', reason: 'timeout' });
      }
    }, timeoutMs);
    this.entries.set(requestId, {
      requestId,
      resolve: resolveFn,
      timeoutHandle,
      createdAt: Date.now(),
    });
    return { requestId, promise };
  }

  resolve(requestId: string, decision: Decision): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timeoutHandle);
    this.entries.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  drainAll(reason: string): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timeoutHandle);
      entry.resolve({ decision: 'deny', reason });
    }
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private cleanupStale(): void {
    const now = Date.now();
    const STALE_MS = 5 * 60 * 1000;
    for (const entry of Array.from(this.entries.values())) {
      if (now - entry.createdAt > STALE_MS) {
        clearTimeout(entry.timeoutHandle);
        this.entries.delete(entry.requestId);
        entry.resolve({ decision: 'deny', reason: 'stale' });
      }
    }
  }
}
