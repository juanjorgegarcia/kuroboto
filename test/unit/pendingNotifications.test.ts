import { describe, it, expect, vi, afterEach } from 'vitest';
import { PendingNotifications } from '../../src/daemon/pendingNotifications.js';
import type { NotificationPayload } from '../../src/core/types.js';

const SAMPLE: NotificationPayload = {
  session_id: 's',
  hook_event_name: 'Notification',
  message: 'wake',
};

describe('PendingNotifications', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback after the configured delay when nothing cancels', () => {
    vi.useFakeTimers();
    const map = new PendingNotifications();
    const fire = vi.fn();
    map.arm(SAMPLE, 60_000, fire);
    expect(map.size()).toBe(1);
    vi.advanceTimersByTime(59_999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(map.size()).toBe(0);
  });

  it('cancelAll clears every pending entry without firing', () => {
    vi.useFakeTimers();
    const map = new PendingNotifications();
    const fire = vi.fn();
    map.arm(SAMPLE, 60_000, fire);
    map.arm(SAMPLE, 60_000, fire);
    expect(map.size()).toBe(2);
    expect(map.cancelAll()).toBe(2);
    expect(map.size()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it('cancelAll on an empty map returns 0', () => {
    const map = new PendingNotifications();
    expect(map.cancelAll()).toBe(0);
  });
});
