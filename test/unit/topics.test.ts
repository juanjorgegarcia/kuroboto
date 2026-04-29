import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TopicManager, type TopicAuditEvent } from '../../src/channels/telegram/topics.js';
import { noopLogger } from '../helpers/mockChannel.js';

class FakeApi {
  public calls: Array<{ chatId: number; name: string }> = [];
  public nextId = 100;
  public failNext: Error | null = null;

  async createForumTopic(chatId: number, name: string): Promise<number> {
    this.calls.push({ chatId, name });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return this.nextId++;
  }
}

describe('TopicManager', () => {
  let dir: string;
  let storagePath: string;
  let api: FakeApi;
  let auditEvents: TopicAuditEvent[];

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-topics-'));
    storagePath = path.join(dir, 'topics.json');
    api = new FakeApi();
    auditEvents = [];
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  function make(forumMode = true): TopicManager {
    return new TopicManager({
      api,
      chatId: -100123,
      forumMode,
      storagePath,
      logger: noopLogger,
      audit: (e) => auditEvents.push(e),
    });
  }

  it('first resolve creates topic, persists to disk, returns thread id', async () => {
    const tm = make();
    const id = await tm.resolve('fix-bot-ux', 'fix-bot-ux');
    expect(id).toBe(100);
    expect(api.calls).toEqual([{ chatId: -100123, name: 'fix-bot-ux' }]);
    const persisted = JSON.parse(await fsp.readFile(storagePath, 'utf-8'));
    expect(persisted).toEqual({ 'fix-bot-ux': 100 });
    expect(auditEvents).toEqual([
      { source: 'topic-created', key: 'fix-bot-ux', name: 'fix-bot-ux', threadId: 100 },
    ]);
  });

  it('second resolve same key is a cache hit (no api call)', async () => {
    const tm = make();
    await tm.resolve('fix-bot-ux', 'fix-bot-ux');
    const id = await tm.resolve('fix-bot-ux', 'fix-bot-ux');
    expect(id).toBe(100);
    expect(api.calls).toHaveLength(1);
  });

  it('concurrent resolves for the same key share one createForumTopic call', async () => {
    const tm = make();
    const [a, b, c] = await Promise.all([
      tm.resolve('k', 'k'),
      tm.resolve('k', 'k'),
      tm.resolve('k', 'k'),
    ]);
    expect(a).toBe(100);
    expect(b).toBe(100);
    expect(c).toBe(100);
    expect(api.calls).toHaveLength(1);
  });

  it('returns undefined and skips api call when forumMode is false', async () => {
    const tm = make(false);
    const id = await tm.resolve('x', 'x');
    expect(id).toBeUndefined();
    expect(api.calls).toHaveLength(0);
    expect(auditEvents).toEqual([]);
  });

  it('createForumTopic failure → undefined, no cache, no disk write, audit failed', async () => {
    api.failNext = new Error('rate limited');
    const tm = make();
    const id = await tm.resolve('k', 'k');
    expect(id).toBeUndefined();
    await expect(fsp.access(storagePath)).rejects.toThrow();
    expect(auditEvents).toEqual([
      { source: 'topic-create-failed', key: 'k', name: 'k', error: 'rate limited' },
    ]);
    // Next resolve retries (failure didn't poison cache)
    const id2 = await tm.resolve('k', 'k');
    expect(id2).toBe(100);
  });

  it('purge removes from cache and disk, fires audit', async () => {
    const tm = make();
    await tm.resolve('a', 'a');
    await tm.resolve('b', 'b');
    auditEvents.length = 0;
    await tm.purge('a');
    expect(auditEvents).toEqual([{ source: 'topic-purged', key: 'a' }]);
    const persisted = JSON.parse(await fsp.readFile(storagePath, 'utf-8'));
    expect(persisted).toEqual({ b: 101 });
  });

  it('purge of unknown key is a no-op (no audit, no rewrite)', async () => {
    const tm = make();
    await tm.resolve('a', 'a');
    auditEvents.length = 0;
    const beforeWrite = (await fsp.stat(storagePath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    await tm.purge('does-not-exist');
    expect(auditEvents).toEqual([]);
    expect((await fsp.stat(storagePath)).mtimeMs).toBe(beforeWrite);
  });

  it('loadFromDisk with malformed json starts empty (no throw)', async () => {
    await fsp.writeFile(storagePath, '{not valid');
    const tm = make();
    const id = await tm.resolve('k', 'k');
    // Cache started empty, so resolve creates a new topic
    expect(id).toBe(100);
    expect(api.calls).toHaveLength(1);
  });

  it('loadFromDisk with non-object json starts empty', async () => {
    await fsp.writeFile(storagePath, '"unexpected"');
    const tm = make();
    const id = await tm.resolve('k', 'k');
    expect(id).toBe(100);
  });

  it('loadFromDisk filters out non-numeric values', async () => {
    await fsp.writeFile(storagePath, JSON.stringify({ ok: 42, bad: 'string' }));
    const tm = make();
    const ok = await tm.resolve('ok', 'ok');
    expect(ok).toBe(42);
    expect(api.calls).toHaveLength(0);
    const bad = await tm.resolve('bad', 'bad');
    expect(bad).toBe(100);
    expect(api.calls).toHaveLength(1);
  });

  it('loadFromDisk picks up entries written by a previous run', async () => {
    await fsp.writeFile(storagePath, JSON.stringify({ 'pre-existing': 7 }));
    const tm = make();
    const id = await tm.resolve('pre-existing', 'pre-existing');
    expect(id).toBe(7);
    expect(api.calls).toHaveLength(0);
  });

  it('flushToDisk failure is logged but cache survives in memory', async () => {
    const writeSpy = vi.spyOn(fsp, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    const tm = make();
    const id = await tm.resolve('k', 'k');
    expect(id).toBe(100);
    expect(writeSpy).toHaveBeenCalled();
    // Subsequent resolve still hits cache despite the persist failure
    const id2 = await tm.resolve('k', 'k');
    expect(id2).toBe(100);
    expect(api.calls).toHaveLength(1);
    writeSpy.mockRestore();
  });
});
