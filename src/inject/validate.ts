import { runTmux, type TmuxRunFn, type TmuxRunResult } from './tmux.js';
import { DaemonError } from '../core/errors.js';

const defaultRun: TmuxRunFn = (args) => runTmux(args);

export async function validateTmuxAvailable(
  session: string,
  run: TmuxRunFn = defaultRun,
): Promise<void> {
  const v = await safeRun(run, ['-V'], (e) =>
    new DaemonError(
      `tmux not found in PATH; either install tmux or set inject.enabled=false (${e.message})`,
    ),
  );
  if (v.code !== 0) {
    throw new DaemonError(
      'tmux not found in PATH; either install tmux or set inject.enabled=false',
    );
  }
  const h = await safeRun(run, ['has-session', '-t', session], (e) =>
    new DaemonError(`tmux has-session failed for '${session}': ${e.message}`),
  );
  if (h.code !== 0) {
    throw new DaemonError(
      `tmux session '${session}' not found; create it before starting kuroboto`,
    );
  }
}

async function safeRun(
  run: TmuxRunFn,
  args: readonly string[],
  wrap: (e: Error) => Error,
): Promise<TmuxRunResult> {
  try {
    return await run(args);
  } catch (e) {
    throw wrap(e as Error);
  }
}
