import { describe, it, expect, vi } from 'vitest';
import { notifyDesktop, type DesktopNotifyDeps } from '../../src/notify/desktop.js';

interface NotifyCall {
  title: string;
  message: string;
  sound: boolean;
  wait: boolean;
}

function makeDeps(behavior: 'ok' | 'error' | 'throw' = 'ok'): {
  deps: DesktopNotifyDeps;
  calls: NotifyCall[];
  logs: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const calls: NotifyCall[] = [];
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const deps: DesktopNotifyDeps = {
    notify: vi.fn((notification, callback) => {
      calls.push(notification);
      if (behavior === 'throw') {
        throw new Error('synchronous fail');
      }
      const err = behavior === 'error' ? new Error('notif daemon down') : null;
      setImmediate(() => callback(err));
    }),
    log: (msg, fields) => {
      logs.push({ msg, fields });
    },
  };
  return { deps, calls, logs };
}

describe('notifyDesktop', () => {
  it('success level → calls notifier with sound: false', async () => {
    const { deps, calls } = makeDeps();
    await notifyDesktop({ title: 't', body: 'b', level: 'success' }, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ title: 't', message: 'b', sound: false, wait: false });
  });

  it('error level → calls notifier with sound: true', async () => {
    const { deps, calls } = makeDeps();
    await notifyDesktop({ title: 't', body: 'b', level: 'error' }, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ title: 't', message: 'b', sound: true, wait: false });
  });

  it('notifier callback error → resolves silently and logs', async () => {
    const { deps, logs } = makeDeps('error');
    await expect(
      notifyDesktop({ title: 't', body: 'b', level: 'success' }, deps),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.msg.includes('failed'))).toBe(true);
  });

  it('notifier throws synchronously → resolves silently and logs', async () => {
    const { deps, logs } = makeDeps('throw');
    await expect(
      notifyDesktop({ title: 't', body: 'b', level: 'error' }, deps),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.msg.includes('threw'))).toBe(true);
  });

  it('long body is passed through verbatim (OS truncates)', async () => {
    const { deps, calls } = makeDeps();
    const long = 'x'.repeat(500);
    await notifyDesktop({ title: 't', body: long, level: 'success' }, deps);
    expect(calls[0].message).toBe(long);
    expect(calls[0].message.length).toBe(500);
  });
});
