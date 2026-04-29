import { describe, it, expect } from 'vitest';
import {
  topicContextFromHook,
  topicContextForSleep,
  topicContextSystem,
} from '../../src/daemon/topicContext.js';
import { InjectClients } from '../../src/daemon/injectClients.js';
import { pickTopicKey } from '../../src/channels/telegram/topics.js';

function emptySleep() {
  return { active: [], capacity: 3 };
}

describe('topicContextFromHook', () => {
  it('matches an active sleep worktree → isSleep + sleep slug', () => {
    const ctx = topicContextFromHook(
      { cwd: '/tmp/work/fix-bot-ux-abc123', session_id: 's' },
      {
        injectClients: new InjectClients(),
        sleepingSnap: {
          active: [
            {
              slug: 'fix-bot-ux-abc123',
              branch: 'sleep/fix-bot-ux-abc123',
              worktreePath: '/tmp/work/fix-bot-ux-abc123',
              startedAt: 0,
              expectedEndAt: 0,
            },
          ],
          capacity: 3,
        },
      },
    );
    expect(ctx).toEqual({ slug: 'fix-bot-ux-abc123', isSleep: true });
    expect(pickTopicKey(ctx).name).toBe('💤 fix-bot-ux');
  });

  it('uses bound CLI client slug when session is bound', () => {
    const clients = new InjectClients();
    clients.register({ slug: 'proj-a', pid: 1, cwd: '/x/proj-a', localPort: 5000, registeredAt: 0 });
    clients.bindSessionToSlug('sess-1', 'proj-a');
    const ctx = topicContextFromHook(
      { cwd: '/elsewhere', session_id: 'sess-1' },
      { injectClients: clients, sleepingSnap: emptySleep() },
    );
    expect(ctx).toEqual({ slug: 'proj-a' });
  });

  it('late-binds via cwd match when session is not yet bound', () => {
    const clients = new InjectClients();
    clients.register({ slug: 'proj-b', pid: 1, cwd: '/x/proj-b', localPort: 5001, registeredAt: 0 });
    const ctx = topicContextFromHook(
      { cwd: '/x/proj-b', session_id: 'sess-fresh' },
      { injectClients: clients, sleepingSnap: emptySleep() },
    );
    expect(ctx).toEqual({ slug: 'proj-b' });
  });

  it('falls back to bare session_id with cwd basename when no slug found', () => {
    const ctx = topicContextFromHook(
      { cwd: '/some/path/kuroboto', session_id: 'a3f9b2c1-rest' },
      { injectClients: new InjectClients(), sleepingSnap: emptySleep() },
    );
    expect(ctx).toEqual({ sessionId: 'a3f9b2c1-rest', cwdBasename: 'kuroboto' });
    expect(pickTopicKey(ctx).name).toBe('kuroboto-a3f9b2c1');
  });

  it('drops basename when cwd is missing', () => {
    const ctx = topicContextFromHook(
      { session_id: 'a3f9b2c1-rest' },
      { injectClients: new InjectClients(), sleepingSnap: emptySleep() },
    );
    expect(ctx).toEqual({ sessionId: 'a3f9b2c1-rest', cwdBasename: undefined });
  });
});

describe('topicContextForSleep / topicContextSystem', () => {
  it('sleep returns slug + isSleep', () => {
    expect(topicContextForSleep('s-abc123')).toEqual({ slug: 's-abc123', isSleep: true });
  });

  it('system returns { system: true }', () => {
    expect(topicContextSystem()).toEqual({ system: true });
  });
});

describe('pickTopicKey', () => {
  it('strips suffix from sleep topic name', () => {
    expect(pickTopicKey({ slug: 'foo-bar-abc123', isSleep: true })).toEqual({
      key: 'foo-bar-abc123',
      name: '💤 foo-bar',
    });
  });

  it('uses slug as both key and name for client slugs', () => {
    expect(pickTopicKey({ slug: 'fix-bot-ux' })).toEqual({
      key: 'fix-bot-ux',
      name: 'fix-bot-ux',
    });
  });

  it('falls back to system topic when nothing identifies the source', () => {
    expect(pickTopicKey(undefined)).toEqual({
      key: 'kuroboto-system',
      name: 'kuroboto-system',
    });
    expect(pickTopicKey({})).toEqual({
      key: 'kuroboto-system',
      name: 'kuroboto-system',
    });
  });

  it('explicit system flag wins regardless of other fields', () => {
    expect(pickTopicKey({ system: true, slug: 'x' })).toEqual({
      key: 'kuroboto-system',
      name: 'kuroboto-system',
    });
  });
});
