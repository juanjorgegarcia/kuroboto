import { describe, it, expect } from 'vitest';
import {
  listMergedSleeps,
  cleanupMerged,
  type ExecFn,
  type ExecResult,
} from '../../../src/cli/sleepingCleanup.js';

interface ExecCall {
  cmd: string;
  args: string[];
}

function makeExec(handlers: Record<string, ExecResult | ((args: string[]) => ExecResult)>): {
  exec: ExecFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args[0]}${args[1] ? ' ' + args[1] : ''}`;
    const handler = handlers[key] ?? handlers[`${cmd} ${args[0]}`] ?? handlers[cmd];
    if (!handler) return { code: 0, stdout: '', stderr: '' };
    return typeof handler === 'function' ? handler(args) : handler;
  };
  return { exec, calls };
}

const PR_LIST = JSON.stringify([
  { number: 10, headRefName: 'sleep/feat-x-abc123', state: 'MERGED' },
  { number: 11, headRefName: 'sleep/feat-y-def456', state: 'MERGED' },
  { number: 12, headRefName: 'sleep/in-flight-ghi789', state: 'OPEN' },
  { number: 13, headRefName: 'main', state: 'MERGED' },
]);

describe('listMergedSleeps', () => {
  it('returns only merged PRs whose branch starts with sleep/', async () => {
    const { exec } = makeExec({ 'gh pr': { code: 0, stdout: PR_LIST, stderr: '' } });
    const merged = await listMergedSleeps({ exec, workRoot: '/wk' });
    expect(merged.map((m) => m.slug)).toEqual(['feat-x-abc123', 'feat-y-def456']);
    expect(merged[0]).toMatchObject({
      prNumber: 10,
      branch: 'sleep/feat-x-abc123',
      slug: 'feat-x-abc123',
      worktreePath: expect.stringContaining('feat-x-abc123'),
    });
  });

  it('passes --state merged + --head sleep/ to gh', async () => {
    const { exec, calls } = makeExec({ 'gh pr': { code: 0, stdout: '[]', stderr: '' } });
    await listMergedSleeps({ exec, workRoot: '/wk' });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('--state');
    expect(calls[0].args).toContain('merged');
    expect(calls[0].args).toContain('--head');
    expect(calls[0].args).toContain('sleep/');
  });

  it('throws a clear error when gh fails', async () => {
    const { exec } = makeExec({ 'gh pr': { code: 1, stdout: '', stderr: 'auth error' } });
    await expect(listMergedSleeps({ exec, workRoot: '/wk' })).rejects.toThrow(/auth error/);
  });

  it('throws when gh returns invalid JSON', async () => {
    const { exec } = makeExec({ 'gh pr': { code: 0, stdout: 'not json', stderr: '' } });
    await expect(listMergedSleeps({ exec, workRoot: '/wk' })).rejects.toThrow(/invalid JSON/i);
  });

  it('returns empty list when no merged sleeps exist', async () => {
    const { exec } = makeExec({ 'gh pr': { code: 0, stdout: '[]', stderr: '' } });
    expect(await listMergedSleeps({ exec, workRoot: '/wk' })).toEqual([]);
  });
});

describe('cleanupMerged', () => {
  const ENTRIES = [
    { prNumber: 10, branch: 'sleep/feat-x-abc123', slug: 'feat-x-abc123', worktreePath: '/wk/feat-x-abc123' },
    { prNumber: 11, branch: 'sleep/feat-y-def456', slug: 'feat-y-def456', worktreePath: '/wk/feat-y-def456' },
  ];

  it('removes worktree, deletes local branch, prunes remote for each entry', async () => {
    const { exec, calls } = makeExec({ git: { code: 0, stdout: '', stderr: '' } });
    const log: string[] = [];
    const results = await cleanupMerged(ENTRIES, { exec, workRoot: '/wk', log: (l) => log.push(l) });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.worktreeRemoved && r.branchDeleted && r.remotePruned)).toBe(true);
    // expected calls: 2× worktree remove, 2× branch -D, 1× fetch --prune
    const wtCalls = calls.filter((c) => c.args[0] === 'worktree');
    expect(wtCalls).toHaveLength(2);
    expect(wtCalls[0].args).toEqual(['worktree', 'remove', '--force', '/wk/feat-x-abc123']);
    const brCalls = calls.filter((c) => c.args[0] === 'branch');
    expect(brCalls).toHaveLength(2);
    expect(brCalls[0].args).toEqual(['branch', '-D', 'sleep/feat-x-abc123']);
    const prune = calls.filter((c) => c.args[0] === 'fetch');
    expect(prune).toHaveLength(1);
    expect(prune[0].args).toEqual(['fetch', '--prune']);
  });

  it('treats "not a working tree" as already-clean (no error)', async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree') {
        return { code: 1, stdout: '', stderr: 'fatal: not a working tree' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const results = await cleanupMerged([ENTRIES[0]], { exec, workRoot: '/wk', log: () => {}, warn: () => {} });
    expect(results[0].errors).toEqual([]);
    expect(results[0].worktreeRemoved).toBe(false);
    expect(results[0].branchDeleted).toBe(true);
  });

  it('treats "branch not found" as already-deleted (no error)', async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'branch') {
        return { code: 1, stdout: '', stderr: 'error: branch sleep/foo not found' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const results = await cleanupMerged([ENTRIES[0]], { exec, workRoot: '/wk', log: () => {}, warn: () => {} });
    expect(results[0].errors).toEqual([]);
    expect(results[0].branchDeleted).toBe(false);
  });

  it('records a real worktree-remove failure as an error', async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree') {
        return { code: 1, stdout: '', stderr: 'permission denied' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const results = await cleanupMerged([ENTRIES[0]], { exec, workRoot: '/wk', log: () => {}, warn: () => {} });
    expect(results[0].errors[0]).toMatch(/permission denied/);
  });
});
