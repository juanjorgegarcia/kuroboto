import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanOrphanWorktrees } from '../../src/daemon/orphanWorktrees.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orphan-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function makeStaleDir(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fsp.mkdir(dir, { recursive: true });
  // Force the mtime to 1 hour ago so the freshness filter doesn't keep it.
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await fsp.utimes(dir, past, past);
  return dir;
}

describe('scanOrphanWorktrees', () => {
  it('returns empty when the workRoot does not exist', async () => {
    const result = await scanOrphanWorktrees({
      workRoot: path.join(tmpRoot, 'does-not-exist'),
      listOpenSleepBranches: async () => new Set(),
    });
    expect(result).toEqual([]);
  });

  it('flags a stale directory whose branch has no open PR', async () => {
    await makeStaleDir('feature-abc-123456');
    const result = await scanOrphanWorktrees({
      workRoot: tmpRoot,
      listOpenSleepBranches: async () => new Set(),
    });
    expect(result.map((o) => o.slug)).toEqual(['feature-abc-123456']);
  });

  it('skips a directory that is fresh (mtime within last 5 min)', async () => {
    const dir = path.join(tmpRoot, 'fresh-slug-aaaaaa');
    await fsp.mkdir(dir, { recursive: true });
    // mtime defaults to now — within 5min window
    const result = await scanOrphanWorktrees({
      workRoot: tmpRoot,
      listOpenSleepBranches: async () => new Set(),
    });
    expect(result).toEqual([]);
  });

  it('skips a stale directory when its branch has an open PR (v2 implementation already handled it)', async () => {
    await makeStaleDir('staged-feature-bbbbbb');
    const result = await scanOrphanWorktrees({
      workRoot: tmpRoot,
      listOpenSleepBranches: async () => new Set(['staged-feature-bbbbbb']),
    });
    expect(result).toEqual([]);
  });

  it('survives gh failure — assumes no open branches and still flags stale ones', async () => {
    await makeStaleDir('orphaned-cccccc');
    const result = await scanOrphanWorktrees({
      workRoot: tmpRoot,
      listOpenSleepBranches: async () => {
        throw new Error('gh missing');
      },
    });
    expect(result.map((o) => o.slug)).toEqual(['orphaned-cccccc']);
  });
});
