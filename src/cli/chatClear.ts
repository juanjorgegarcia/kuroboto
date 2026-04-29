import chalk from 'chalk';
import prompts from 'prompts';
import { kuroFetch } from './http.js';

export interface ChatClearOpts {
  last?: string;
  dryRun?: boolean;
  yes?: boolean;
}

interface ClearResponse {
  ok?: boolean;
  attempted?: number;
  deleted?: number;
  outOfWindow?: number;
  dryRun?: boolean;
  error?: string;
}

export async function chatClearCommand(opts: ChatClearOpts): Promise<void> {
  const last = opts.last ? Number.parseInt(opts.last, 10) : NaN;
  if (!Number.isFinite(last) || last <= 0) {
    console.error(chalk.red('--last <N> required (positive integer)'));
    process.exit(1);
  }

  if (!opts.yes && !opts.dryRun) {
    const confirm = await prompts({
      type: 'confirm',
      name: 'val',
      message: `delete the last ${last} bot message${last === 1 ? '' : 's'}?`,
      initial: false,
    });
    if (confirm.val !== true) {
      console.log(chalk.dim('aborted'));
      return;
    }
  }

  const res = await kuroFetch<ClearResponse>('/v1/chat/clear', {
    method: 'POST',
    body: { last, dryRun: opts.dryRun === true },
    timeoutMs: Math.max(15_000, last * 200),
  });
  if (!res.ok) {
    console.error(chalk.red(res.body.error ?? `daemon HTTP ${res.status}`));
    process.exit(1);
  }

  const attempted = res.body.attempted ?? 0;
  const deleted = res.body.deleted ?? 0;
  const outOfWindow = res.body.outOfWindow ?? 0;
  if (res.body.dryRun) {
    console.log(chalk.dim(`would attempt ${attempted} (${outOfWindow} outside 48h window)`));
    return;
  }
  console.log(
    chalk.green(`deleted ${deleted} of last ${attempted}`) +
      (outOfWindow > 0 ? chalk.dim(` (${outOfWindow} outside 48h delete window)`) : ''),
  );
}
