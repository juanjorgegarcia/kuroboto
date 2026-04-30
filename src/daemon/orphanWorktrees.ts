import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Scope-limited v1 of sleep recovery (Spec G). When the daemon restarts —
 * whether from a clean stop or after the watchdog respawns it — any sleep
 * sessions that died alongside the previous daemon leave behind worktrees
 * but no in-memory record. We can't safely re-attach (their stdout pipes
 * are gone), but we can spot the leftovers and tell the user.
 *
 * A worktree is "orphaned" when:
 *   - it lives under workRoot/
 *   - its filesystem mtime is older than 5 minutes (no recent activity)
 *   - its corresponding sleep/<slug> branch has no open PR
 *
 * The third condition is checked via `gh` so that branches a v2 implementation
 * already submitted PRs for are not flagged. v1 is observational: we surface
 * the slug and let the user reclaim manually with `kuroboto sleeping cancel`
 * or `kuroboto sleeping cleanup`.
 */

export interface OrphanScanDeps {
  workRoot: string;
  /** Returns the set of branch names (without `sleep/` prefix) that have an open PR. */
  listOpenSleepBranches: () => Promise<Set<string>>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** "Now" injection for tests — defaults to Date.now(). */
  now?: () => number;
}

export interface OrphanWorktree {
  slug: string;
  worktreePath: string;
  /** Filesystem mtime ms — useful for diagnostics. */
  mtimeMs: number;
}

const ORPHAN_INACTIVITY_MS = 5 * 60 * 1000;

/**
 * Scan workRoot for orphaned sleep worktrees. Returns the list of slugs
 * that look orphaned. Errors during the scan are swallowed and logged —
 * a partial scan is better than blocking daemon startup.
 */
export async function scanOrphanWorktrees(deps: OrphanScanDeps): Promise<OrphanWorktree[]> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;

  let entries: string[];
  try {
    entries = await fsp.readdir(deps.workRoot);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log('orphan scan: readdir failed', { err: (e as Error).message });
    }
    return [];
  }

  let openBranches: Set<string>;
  try {
    openBranches = await deps.listOpenSleepBranches();
  } catch (e) {
    log('orphan scan: failed to list open PRs (assuming none)', { err: (e as Error).message });
    openBranches = new Set();
  }

  const cutoff = now() - ORPHAN_INACTIVITY_MS;
  const out: OrphanWorktree[] = [];
  for (const slug of entries) {
    const dir = path.join(deps.workRoot, slug);
    let stat;
    try {
      stat = await fsp.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (stat.mtimeMs > cutoff) continue;
    if (openBranches.has(slug)) continue;
    out.push({ slug, worktreePath: dir, mtimeMs: stat.mtimeMs });
  }
  return out;
}
