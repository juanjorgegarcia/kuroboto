import { describe, it, expect } from 'vitest';
import { TmuxInjectStrategy, type TmuxRunFn, type TmuxRunResult } from '../../src/inject/tmux.js';

function makeRunner(result: TmuxRunResult = { code: 0, stderr: '' }): {
  run: TmuxRunFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: TmuxRunFn = async (args) => {
    calls.push([...args]);
    return result;
  };
  return { run, calls };
}

describe('TmuxInjectStrategy', () => {
  it('runs send-keys -l <text> then send-keys Enter', async () => {
    const { run, calls } = makeRunner();
    const strategy = new TmuxInjectStrategy('claude', run);
    await strategy.inject('hello');
    expect(calls).toEqual([
      ['send-keys', '-t', 'claude', '-l', 'hello'],
      ['send-keys', '-t', 'claude', 'Enter'],
    ]);
  });

  it('preserves quotes verbatim in the args', async () => {
    const { run, calls } = makeRunner();
    const strategy = new TmuxInjectStrategy('claude', run);
    await strategy.inject('he said "hi"');
    expect(calls[0]).toEqual(['send-keys', '-t', 'claude', '-l', 'he said "hi"']);
  });

  it('passes shell metacharacters literally (no expansion at our layer)', async () => {
    const { run, calls } = makeRunner();
    const strategy = new TmuxInjectStrategy('claude', run);
    await strategy.inject('echo $HOME `whoami`');
    expect(calls[0]).toEqual(['send-keys', '-t', 'claude', '-l', 'echo $HOME `whoami`']);
  });

  it('passes embedded newlines through (multiline replies)', async () => {
    const { run, calls } = makeRunner();
    const strategy = new TmuxInjectStrategy('claude', run);
    await strategy.inject('line one\nline two');
    expect(calls[0]).toEqual(['send-keys', '-t', 'claude', '-l', 'line one\nline two']);
    // Single trailing Enter — we don't fragment on \n
    expect(calls[1]).toEqual(['send-keys', '-t', 'claude', 'Enter']);
  });

  it('uses the configured session name', async () => {
    const { run, calls } = makeRunner();
    const strategy = new TmuxInjectStrategy('my-session', run);
    await strategy.inject('x');
    expect(calls[0][2]).toBe('my-session');
  });

  it('rejects with stderr when tmux exits non-zero', async () => {
    const { run } = makeRunner({ code: 1, stderr: 'no server running' });
    const strategy = new TmuxInjectStrategy('claude', run);
    await expect(strategy.inject('x')).rejects.toThrow(/exited 1.*no server running/);
  });
});
