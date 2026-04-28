import { randomUUID } from 'node:crypto';
import type { NotificationPayload } from '../core/types.js';

export type NotificationFireCallback = (payload: NotificationPayload) => void;

interface PendingNotificationEntry {
  requestId: string;
  payload: NotificationPayload;
  createdAt: number;
  timer: NodeJS.Timeout;
}

export class PendingNotifications {
  private readonly entries = new Map<string, PendingNotificationEntry>();

  arm(payload: NotificationPayload, delayMs: number, fire: NotificationFireCallback): string {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      this.entries.delete(requestId);
      fire(payload);
    }, delayMs);
    this.entries.set(requestId, { requestId, payload, createdAt: Date.now(), timer });
    return requestId;
  }

  /** Cancel every pending notification (used when a heartbeat fires). */
  cancelAll(): number {
    const count = this.entries.size;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
    return count;
  }

  size(): number {
    return this.entries.size;
  }
}
