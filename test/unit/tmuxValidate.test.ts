import { describe, it, expect } from 'vitest';
import { validateTmuxAvailable } from '../../src/inject/validate.js';
import type { TmuxRunFn, TmuxRunResult } from '../../src/inject/tmux.js';

function fakeRunner(map: Record<string, TmuxRunResult | Error>): TmuxRunFn {
  return async (args) => {
    const key = args.join(' ');
    const result = map[key];
    if (!result) throw new Error(`unexpected runner call: ${key}`);
    if (result instanceof Error) throw result;
    return result;
  };
}

describe('validateTmuxAvailable', () => {
  it('passes when tmux -V and has-session both return code 0', async () => {
    const run = fakeRunner({
      '-V': { code: 0, stderr: '' },
      'has-session -t claude': { code: 0, stderr: '' },
    });
    await expect(validateTmuxAvailable('claude', run)).resolves.toBeUndefined();
  });

  it('throws with clear "tmux not found" error when -V exits non-zero', async () => {
    const run = fakeRunner({
      '-V': { code: 127, stderr: 'tmux: command not found' },
    });
    await expect(validateTmuxAvailable('claude', run)).rejects.toThrow(/tmux not found in PATH/);
  });

  it('throws with clear error when -V spawn errors (e.g. ENOENT)', async () => {
    const run = fakeRunner({
      '-V': new Error('ENOENT'),
    });
    await expect(validateTmuxAvailable('claude', run)).rejects.toThrow(/tmux not found in PATH.*ENOENT/);
  });

  it('throws "session not found" when has-session exits non-zero', async () => {
    const run = fakeRunner({
      '-V': { code: 0, stderr: '' },
      'has-session -t my-session': { code: 1, stderr: "can't find session: my-session" },
    });
    await expect(validateTmuxAvailable('my-session', run)).rejects.toThrow(
      /tmux session 'my-session' not found/,
    );
  });
});
