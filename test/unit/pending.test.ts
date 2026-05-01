import { describe, it, expect } from 'vitest';
import { PendingMap } from '../../src/daemon/pending.js';

describe('PendingMap', () => {
  it('resolves with the decision when resolve is called', async () => {
    const map = new PendingMap();
    const { requestId, promise } = map.create(5_000);
    expect(map.resolve(requestId, { decision: 'allow' })).toBe(true);
    expect(await promise).toEqual({ decision: 'allow' });
  });

  it('returns timeout ask when nobody resolves in time', async () => {
    // On timeout we ask Claude Code to fall back to its native permission UI
    // rather than denying the tool call. Denying surfaces as a "hook blocking
    // error: timeout" and prevents desk users from approving via the CC UI
    // when the Telegram side missed the prompt.
    const map = new PendingMap();
    const { promise } = map.create(50);
    const decision = await promise;
    expect(decision).toEqual({ decision: 'ask', reason: 'timeout' });
  });

  it('drainAll denies every pending entry with the given reason', async () => {
    const map = new PendingMap();
    const a = map.create(5_000);
    const b = map.create(5_000);
    map.drainAll('shutdown');
    expect(await a.promise).toEqual({ decision: 'deny', reason: 'shutdown' });
    expect(await b.promise).toEqual({ decision: 'deny', reason: 'shutdown' });
    expect(map.size()).toBe(0);
  });

  it('keeps requestIds independent under concurrency', async () => {
    const map = new PendingMap();
    const a = map.create(5_000);
    const b = map.create(5_000);
    expect(a.requestId).not.toBe(b.requestId);
    map.resolve(b.requestId, { decision: 'deny' });
    map.resolve(a.requestId, { decision: 'allow' });
    expect(await a.promise).toEqual({ decision: 'allow' });
    expect(await b.promise).toEqual({ decision: 'deny' });
  });

  it('returns false when resolving an unknown requestId', () => {
    const map = new PendingMap();
    expect(map.resolve('nonexistent', { decision: 'allow' })).toBe(false);
  });
});
