import { describe, it, expect, vi } from 'vitest';
import { finishSleep, type FinishDeps } from '../../src/daemon/sleepFinish.js';
import type { SleepingSession } from '../../src/daemon/sleeping.js';

const SESSION: SleepingSession = {
  slug: 'add-feature-x',
  branch: 'sleep/add-feature-x',
  worktreePath: '/tmp/worktrees/add-feature-x',
  startedAt: 1_000_000,
  expectedEndAt: 7_200_000,
  prompt: 'add feature x',
  repo: '/tmp/repo',
};

function makeDeps(prUrl = 'https://github.com/x/y/pull/42'): { deps: FinishDeps; calls: { exec: Array<{ cmd: string; args: string[]; cwd?: string }>; notify: string[] } } {
  const calls = { exec: [] as Array<{ cmd: string; args: string[]; cwd?: string }>, notify: [] as string[] };
  const deps: FinishDeps = {
    exec: vi.fn(async (cmd, args, opts) => {
      calls.exec.push({ cmd, args, cwd: opts?.cwd });
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return { code: 0, stdout: prUrl + '\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
    notify: vi.fn(async (msg) => { calls.notify.push(msg); }),
  };
  return { deps, calls };
}

describe('finishSleep', () => {
  it('pushes branch then runs gh pr create with title and body, then notifies', async () => {
    const { deps, calls } = makeDeps();
    await finishSleep(SESSION, deps);
    const cmds = calls.exec.map((c) => `${c.cmd} ${c.args.slice(0, 3).join(' ')}`);
    expect(cmds[0]).toContain('git push');
    expect(cmds[1]).toContain('gh pr create');
    // gh runs in the worktree dir
    expect(calls.exec[1].cwd).toBe(SESSION.worktreePath);
    // notification includes the URL
    expect(calls.notify).toHaveLength(1);
    expect(calls.notify[0]).toContain('https://github.com/x/y/pull/42');
  });

  it('failure notification when git push fails', async () => {
    const { deps, calls } = makeDeps();
    deps.exec = vi.fn(async (cmd) => {
      if (cmd === 'git') return { code: 1, stdout: '', stderr: 'no upstream' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await finishSleep(SESSION, deps);
    expect(calls.notify[0]).toMatch(/push failed|sleep finalize failed/i);
  });

  it('failure notification when gh pr create fails', async () => {
    const { deps, calls } = makeDeps();
    deps.exec = vi.fn(async (cmd, args) => {
      if (cmd === 'git') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'gh' && args.includes('pr')) return { code: 1, stdout: '', stderr: 'no remote' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await finishSleep(SESSION, deps);
    expect(calls.notify[0]).toMatch(/pr create failed|sleep finalize failed/i);
  });

  it('PR title comes from the slug (humanised)', async () => {
    const { deps, calls } = makeDeps();
    await finishSleep(SESSION, deps);
    const ghCall = calls.exec.find((c) => c.cmd === 'gh');
    expect(ghCall).toBeDefined();
    const title = ghCall!.args[ghCall!.args.indexOf('--title') + 1];
    expect(title.toLowerCase()).toContain('add feature x');
  });

  it('PR body includes the prompt and a sleep-mode origin marker', async () => {
    const { deps, calls } = makeDeps();
    await finishSleep(SESSION, deps);
    const ghCall = calls.exec.find((c) => c.cmd === 'gh');
    const body = ghCall!.args[ghCall!.args.indexOf('--body') + 1];
    expect(body).toContain('add feature x');
    expect(body).toMatch(/sleep mode|kuroboto sleeping|automated/i);
  });
});
