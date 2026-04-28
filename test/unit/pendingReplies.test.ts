import { describe, it, expect } from 'vitest';
import { PendingReplies } from '../../src/daemon/pendingReplies.js';

describe('PendingReplies', () => {
  it('resolves with the reply text when resolveBySentMessageId fires', async () => {
    const replies = new PendingReplies();
    const { promise } = replies.create('msg-1', 5_000);
    expect(replies.size()).toBe(1);
    expect(replies.resolveBySentMessageId('msg-1', 'A')).toBe(true);
    expect(await promise).toBe('A');
    expect(replies.size()).toBe(0);
  });

  it('rejects with timeout when no reply arrives in time', async () => {
    const replies = new PendingReplies();
    const { promise } = replies.create('msg-2', 30);
    await expect(promise).rejects.toThrow(/timeout/);
    expect(replies.size()).toBe(0);
  });

  it('keeps two pending entries independent', async () => {
    const replies = new PendingReplies();
    const a = replies.create('m-a', 5_000);
    const b = replies.create('m-b', 5_000);
    expect(replies.size()).toBe(2);
    replies.resolveBySentMessageId('m-b', 'reply-b');
    replies.resolveBySentMessageId('m-a', 'reply-a');
    expect(await a.promise).toBe('reply-a');
    expect(await b.promise).toBe('reply-b');
    expect(replies.size()).toBe(0);
  });

  it('returns false (no throw) when resolving an unknown sentMessageId', () => {
    const replies = new PendingReplies();
    expect(replies.resolveBySentMessageId('nope', 'x')).toBe(false);
  });

  it('cancelAll rejects every pending entry with shutdown', async () => {
    const replies = new PendingReplies();
    const a = replies.create('m-a', 5_000);
    const b = replies.create('m-b', 5_000);
    replies.cancelAll();
    await expect(a.promise).rejects.toThrow(/shutdown/);
    await expect(b.promise).rejects.toThrow(/shutdown/);
    expect(replies.size()).toBe(0);
  });
});
