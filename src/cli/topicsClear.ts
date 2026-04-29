import chalk from 'chalk';
import prompts from 'prompts';
import { kuroFetch } from './http.js';

export interface TopicsClearOpts {
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

interface ClearResponse {
  ok?: boolean;
  cleared?: string[];
  failed?: Array<{ key: string; error: string }>;
  dryRun?: boolean;
  error?: string;
}

export async function topicsClearCommand(slug: string | undefined, opts: TopicsClearOpts): Promise<void> {
  if (!slug && !opts.all) {
    console.error(chalk.red('pass <slug> or --all'));
    process.exit(1);
  }
  if (slug && opts.all) {
    console.error(chalk.red('<slug> and --all are mutually exclusive'));
    process.exit(1);
  }

  const body: { slug?: string; all?: boolean; dryRun?: boolean } = { dryRun: opts.dryRun };
  if (opts.all) body.all = true;
  if (slug) body.slug = slug;

  if (!opts.yes && !opts.dryRun) {
    const target = opts.all ? 'all topics (system topic preserved)' : `topic "${slug}"`;
    const confirm = await prompts({
      type: 'confirm',
      name: 'val',
      message: `delete ${target}?`,
      initial: false,
    });
    if (confirm.val !== true) {
      console.log(chalk.dim('aborted'));
      return;
    }
  }

  const res = await kuroFetch<ClearResponse>('/v1/topics/clear', {
    method: 'POST',
    body,
  });
  if (!res.ok) {
    const err = res.body.error ?? `daemon HTTP ${res.status}`;
    if (/forum topics/i.test(err)) {
      console.error(chalk.red(err));
      console.error(chalk.dim('use `kuroboto chat clear` in DM mode'));
    } else {
      console.error(chalk.red(err));
    }
    process.exit(1);
  }

  const cleared = res.body.cleared ?? [];
  const failed = res.body.failed ?? [];
  if (res.body.dryRun) {
    if (cleared.length === 0) {
      console.log(chalk.dim('(no topics would be cleared)'));
    } else {
      console.log(chalk.bold(`would clear ${cleared.length} topic${cleared.length === 1 ? '' : 's'}:`));
      for (const k of cleared) console.log(`  • ${k}`);
    }
    return;
  }
  if (cleared.length === 0 && failed.length === 0) {
    console.log(chalk.dim('(nothing to clear)'));
    return;
  }
  if (cleared.length > 0) {
    console.log(chalk.green(`✓ cleared ${cleared.length} topic${cleared.length === 1 ? '' : 's'}`));
    for (const k of cleared) console.log(`  • ${k}`);
  }
  if (failed.length > 0) {
    console.error(chalk.yellow(`⚠ ${failed.length} failed:`));
    for (const f of failed) console.error(`  • ${f.key}: ${f.error}`);
    process.exit(1);
  }
}
