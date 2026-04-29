import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import prompts from 'prompts';
import { loadConfig } from '../config/load.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface CleanupOpts {
  dryRun?: boolean;
  yes?: boolean;
}

interface PrJson {
  number: number;
  headRefName: string;
  state: string;
}

export interface MergedSleep {
  prNumber: number;
  branch: string;
  slug: string;
  worktreePath: string;
}

export interface CleanupDeps {
  exec: ExecFn;
  workRoot: string;
  confirm?: (msg: string) => Promise<boolean>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Pulls merged sleep PRs from `gh` and resolves each branch to its worktree
 * path. Open PRs are skipped — cleanup only touches branches GitHub considers
 * already merged.
 */
export async function listMergedSleeps(deps: Omit<CleanupDeps, 'confirm' | 'log' | 'warn'>): Promise<MergedSleep[]> {
  const r = await deps.exec('gh', [
    'pr',
    'list',
    '--state', 'merged',
    '--head', 'sleep/',
    '--json', 'number,headRefName,state',
    '--limit', '100',
  ]);
  if (r.code !== 0) {
    throw new Error(`gh pr list failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  let prs: PrJson[];
  try {
    prs = JSON.parse(r.stdout) as PrJson[];
  } catch (e) {
    throw new Error(`gh pr list returned invalid JSON: ${(e as Error).message}`);
  }
  return prs
    .filter((p) => p.state === 'MERGED' && p.headRefName.startsWith('sleep/'))
    .map((p) => {
      const slug = p.headRefName.slice('sleep/'.length);
      return {
        prNumber: p.number,
        branch: p.headRefName,
        slug,
        worktreePath: path.join(deps.workRoot, slug),
      };
    });
}

/**
 * For each merged sleep, removes its worktree, deletes the local branch, and
 * prunes the stale remote ref. Best-effort per step — a missing worktree
 * doesn't stop the branch deletion. Returns the per-entry success summary so
 * tests can assert on it.
 */
export async function cleanupMerged(
  entries: MergedSleep[],
  deps: CleanupDeps,
): Promise<Array<{ slug: string; worktreeRemoved: boolean; branchDeleted: boolean; remotePruned: boolean; errors: string[] }>> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const results: Array<{ slug: string; worktreeRemoved: boolean; branchDeleted: boolean; remotePruned: boolean; errors: string[] }> = [];
  for (const e of entries) {
    const result = { slug: e.slug, worktreeRemoved: false, branchDeleted: false, remotePruned: false, errors: [] as string[] };

    const wt = await deps.exec('git', ['worktree', 'remove', '--force', e.worktreePath]);
    if (wt.code === 0) {
      result.worktreeRemoved = true;
    } else if (/not a working tree|No such|does not exist/i.test(wt.stderr)) {
      // Already cleaned up — fine.
    } else {
      result.errors.push(`worktree remove: ${wt.stderr.trim() || `exit ${wt.code}`}`);
      warn(chalk.yellow(`  ⚠ worktree remove failed for ${e.slug}: ${wt.stderr.trim()}`));
    }

    const br = await deps.exec('git', ['branch', '-D', e.branch]);
    if (br.code === 0) {
      result.branchDeleted = true;
    } else if (/not found/i.test(br.stderr)) {
      // Already gone — fine.
    } else {
      result.errors.push(`branch delete: ${br.stderr.trim() || `exit ${br.code}`}`);
      warn(chalk.yellow(`  ⚠ branch delete failed for ${e.branch}: ${br.stderr.trim()}`));
    }

    log(`  • ${chalk.green('cleaned')} ${e.slug.padEnd(46)} PR #${e.prNumber}`);
    results.push(result);
  }
  // One final prune pass to drop stale `origin/sleep/*` refs.
  const prune = await deps.exec('git', ['fetch', '--prune']);
  if (prune.code === 0) {
    for (const r of results) r.remotePruned = true;
  }
  return results;
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const exec: ExecFn = async (cmd, args) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
};

export async function sleepingCleanupCommand(opts: CleanupOpts): Promise<void> {
  const config = await loadConfig();
  const workRoot = expandHome(config.policy.sleepWorktreeDir);
  const merged = await listMergedSleeps({ exec, workRoot });

  if (merged.length === 0) {
    console.log(chalk.dim('(nenhum sleep mergeado para limpar)'));
    return;
  }

  console.log(chalk.bold(`${merged.length} merged sleep branch${merged.length === 1 ? '' : 'es'} to clean:`));
  for (const e of merged) {
    console.log(`  • ${e.slug.padEnd(46)} PR #${e.prNumber}`);
  }

  if (opts.dryRun) {
    console.log(chalk.dim('(--dry-run; nothing removed)'));
    return;
  }

  if (!opts.yes) {
    const confirm = await prompts({
      type: 'confirm',
      name: 'val',
      message: 'cleanup?',
      initial: false,
    });
    if (confirm.val !== true) {
      console.log(chalk.dim('aborted'));
      return;
    }
  }

  const results = await cleanupMerged(merged, { exec, workRoot });
  const failed = results.filter((r) => r.errors.length > 0);
  if (failed.length > 0) {
    console.error(chalk.red(`${failed.length} entry/entries had errors`));
    process.exit(1);
  }
  console.log(chalk.green(`✓ cleaned ${results.length} sleep branch${results.length === 1 ? '' : 'es'}`));
}
