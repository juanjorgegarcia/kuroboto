import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SLUG_MAX = 40;

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'sleep';
  if (cleaned.length <= SLUG_MAX) return cleaned;
  // truncate at last dash boundary <= SLUG_MAX
  const truncated = cleaned.slice(0, SLUG_MAX);
  const lastDash = truncated.lastIndexOf('-');
  return lastDash > SLUG_MAX / 2 ? truncated.slice(0, lastDash) : truncated;
}

export async function worktreeExists(repoRoot: string, dir: string): Promise<boolean> {
  try {
    await fsp.stat(dir);
  } catch {
    return false;
  }
  const r = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  // Normalize paths for comparison (git may use forward slashes on Windows)
  const normalizedDir = path.resolve(dir).replace(/\\/g, '/');
  return r.stdout.includes(normalizedDir);
}

export async function createWorktree(repoRoot: string, branch: string, dir: string): Promise<void> {
  // Pre-flight: dir must not already have content
  try {
    const entries = await fsp.readdir(dir);
    if (entries.length > 0) throw new Error(`worktree target dir not empty: ${dir}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // Pre-flight: branch must not already exist
  const check = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (check.code === 0) throw new Error(`branch already exists: ${branch}`);

  const r = await runGit(repoRoot, ['worktree', 'add', '-b', branch, dir]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
}

export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  const r = await runGit(repoRoot, ['worktree', 'remove', '--force', dir]);
  if (r.code !== 0) {
    // best-effort fallback
    await fsp.rm(dir, { recursive: true, force: true });
    await runGit(repoRoot, ['worktree', 'prune']);
  }
}
