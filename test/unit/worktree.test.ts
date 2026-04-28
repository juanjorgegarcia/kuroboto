import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  slugify,
  createWorktree,
  removeWorktree,
  worktreeExists,
} from '../../src/daemon/worktree.js';

function git(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function makeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-wt-'));
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  await fsp.writeFile(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with dashes', () => {
    expect(slugify('Implement Billing Flow!', false)).toMatch(/^implement-billing-flow$/);
  });
  it('collapses multiple dashes', () => {
    expect(slugify('foo --- bar', false)).toBe('foo-bar');
  });
  it('trims leading/trailing dashes', () => {
    expect(slugify('  --foo--  ', false)).toBe('foo');
  });
  it('caps length and uses first words', () => {
    const long = 'word '.repeat(50);
    const slug = slugify(long, false);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
  it('handles empty/all-symbols input by returning a fallback', () => {
    expect(slugify('!!!', false)).toBe('sleep');
    expect(slugify('', false)).toBe('sleep');
  });
  it('default mode appends a 6-char random suffix', () => {
    const a = slugify('foo');
    const b = slugify('foo');
    expect(a).toMatch(/^foo-[a-z0-9]{6}$/);
    expect(b).toMatch(/^foo-[a-z0-9]{6}$/);
    expect(a).not.toBe(b); // randomness
  });
});

describe('createWorktree / removeWorktree', () => {
  let repo: string;
  let workRoot: string;

  beforeEach(async () => {
    repo = await makeRepo();
    workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-wtroot-'));
  });
  afterEach(async () => {
    // Try to clean up via git first; fall back to rm
    try {
      git(repo, ['worktree', 'list', '--porcelain']);
      git(repo, ['worktree', 'prune']);
    } catch {}
    await fsp.rm(workRoot, { recursive: true, force: true });
    await fsp.rm(repo, { recursive: true, force: true });
  });

  it('creates a worktree on a new branch off HEAD', async () => {
    const wtPath = path.join(workRoot, 'feat-x');
    await createWorktree(repo, 'sleep/feat-x', wtPath);
    // Worktree dir exists and has README.md from initial commit
    const stat = await fsp.stat(wtPath);
    expect(stat.isDirectory()).toBe(true);
    const readme = await fsp.readFile(path.join(wtPath, 'README.md'), 'utf-8');
    expect(readme).toContain('# test');
    // Branch was created
    const branches = git(repo, ['branch', '--list', 'sleep/feat-x']).stdout;
    expect(branches).toContain('sleep/feat-x');
  });

  it('worktreeExists reflects creation and removal', async () => {
    const wtPath = path.join(workRoot, 'feat-y');
    expect(await worktreeExists(repo, wtPath)).toBe(false);
    await createWorktree(repo, 'sleep/feat-y', wtPath);
    expect(await worktreeExists(repo, wtPath)).toBe(true);
    await removeWorktree(repo, wtPath);
    expect(await worktreeExists(repo, wtPath)).toBe(false);
  });

  it('throws when target dir already exists with content', async () => {
    const wtPath = path.join(workRoot, 'occupied');
    await fsp.mkdir(wtPath, { recursive: true });
    await fsp.writeFile(path.join(wtPath, 'something.txt'), 'x');
    await expect(createWorktree(repo, 'sleep/occupied', wtPath)).rejects.toThrow();
  });

  it('throws when branch name already exists', async () => {
    git(repo, ['branch', 'sleep/dup']);
    const wtPath = path.join(workRoot, 'dup');
    await expect(createWorktree(repo, 'sleep/dup', wtPath)).rejects.toThrow();
  });
});
