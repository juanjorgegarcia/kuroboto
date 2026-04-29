import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { GamingState, type GamingSnapshot } from './gaming.js';
import { slugify } from './worktree.js';
import type { DesktopNotifyOpts } from '../notify/desktop.js';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface SleepingDeps {
  spawn: SpawnFn;
  gaming: GamingState;
  notify: (msg: string) => Promise<void>;
  audit: (entry: Record<string, unknown>) => Promise<void>;
  createWorktree: (repo: string, branch: string, dir: string) => Promise<void>;
  removeWorktree: (repo: string, dir: string) => Promise<void>;
  onSuccess: (session: SleepingSession) => Promise<void>;
  notifyDesktop?: (opts: DesktopNotifyOpts) => Promise<void>;
  /** Maximum concurrent sleep sessions. Spec D — defaults to 3 in config. */
  maxConcurrent: number;
}

export interface SleepingStartRequest {
  repo: string;
  workRoot: string;
  maxDurationMs: number;
  prompt?: string;
  plan?: string;
}

export interface SleepingSession {
  slug: string;
  branch: string;
  worktreePath: string;
  startedAt: number;
  expectedEndAt: number;
  prompt: string;
  repo: string;
}

export interface SessionSnap {
  slug: string;
  branch: string;
  worktreePath: string;
  startedAt: number;
  expectedEndAt: number;
}

export interface SleepingSnapshot {
  active: SessionSnap[];
  capacity: number;
}

export interface CancelOpts {
  slug?: string;
  all?: boolean;
}

export interface CancelResult {
  cancelled: string[];
}

export class CapacityReachedError extends Error {
  constructor(
    public readonly capacity: number,
    public readonly active: SessionSnap[],
  ) {
    super(`capacity reached (${active.length}/${capacity})`);
    this.name = 'CapacityReachedError';
  }
}

interface InternalSession extends SleepingSession {
  child: ChildProcess;
  maxDurationTimer: NodeJS.Timeout;
  terminated: boolean;
}

const PLAN_INTRO =
  'Execute this implementation plan. Follow it task-by-task. Run tests, commit per task, and create a final summary at the end.\n\n';

export class SleepingOrchestrator {
  private readonly sessions = new Map<string, InternalSession>();
  /**
   * Snapshot of gaming state at the moment of the first session start. We arm
   * gaming on the 0→1 sessions transition and restore from this snapshot on
   * the N→0 transition. Per-session restore would race when sessions overlap.
   */
  private firstSessionGamingPrior: GamingSnapshot | null = null;

  constructor(private readonly deps: SleepingDeps) {}

  snapshot(): SleepingSnapshot {
    return {
      active: [...this.sessions.values()].map((s) => ({
        slug: s.slug,
        branch: s.branch,
        worktreePath: s.worktreePath,
        startedAt: s.startedAt,
        expectedEndAt: s.expectedEndAt,
      })),
      capacity: this.deps.maxConcurrent,
    };
  }

  async start(req: SleepingStartRequest): Promise<SleepingSession> {
    if (this.sessions.size >= this.deps.maxConcurrent) {
      throw new CapacityReachedError(this.deps.maxConcurrent, this.snapshot().active);
    }
    if (!req.prompt && !req.plan) throw new Error('prompt or plan required');
    if (req.prompt && req.plan) throw new Error('prompt and plan are mutually exclusive');

    const seed = req.prompt ?? req.plan ?? '';
    const slug = slugify(seed);
    if (this.sessions.has(slug)) {
      // Random suffix in slugify makes this exceedingly unlikely; defense in depth.
      throw new Error(`slug "${slug}" already active`);
    }
    const branch = `sleep/${slug}`;
    const worktreePath = `${req.workRoot}/${slug}`;
    const finalPrompt = req.plan ? PLAN_INTRO + req.plan : (req.prompt as string);

    // createWorktree first — if it fails, we want zero side effects (no
    // gaming arm leak, no half-state). Throws propagate to the caller.
    await this.deps.createWorktree(req.repo, branch, worktreePath);

    // 0 → 1 transition: arm gaming and stash the prior so we can restore on
    // N → 0. Subsequent starts (1 → N) leave gaming alone.
    if (this.sessions.size === 0) {
      this.firstSessionGamingPrior = this.deps.gaming.snapshot();
      if (!this.firstSessionGamingPrior.active) this.deps.gaming.arm();
    }

    const startedAt = Date.now();
    const expectedEndAt = startedAt + req.maxDurationMs;

    const child = this.deps.spawn('claude', ['-p', finalPrompt], { cwd: worktreePath });

    const maxDurationTimer = setTimeout(() => {
      this.handleTimeout(slug);
    }, req.maxDurationMs);

    const session: InternalSession = {
      slug,
      branch,
      worktreePath,
      startedAt,
      expectedEndAt,
      prompt: finalPrompt,
      repo: req.repo,
      child,
      maxDurationTimer,
      terminated: false,
    };
    this.sessions.set(slug, session);

    child.on('exit', (code, signal) => {
      this.handleChildExit(slug, code, signal);
    });

    void this.deps.notify(
      `\u{1F4A4} sleep started — ${slug}, max ${formatDuration(req.maxDurationMs)}`,
    );
    void this.deps.audit({
      ts: new Date(startedAt).toISOString(),
      kind: 'sleep_start',
      slug,
      branch,
      worktreePath,
    });

    return {
      slug,
      branch,
      worktreePath,
      startedAt,
      expectedEndAt,
      prompt: finalPrompt,
      repo: req.repo,
    };
  }

  /**
   * Cancel one or more sessions. Variants:
   *   cancel({ slug })       — cancel that specific slug
   *   cancel({ all: true })  — cancel every active session
   *   cancel()               — cancel the only active session; throws if multiple
   */
  async cancel(opts: CancelOpts = {}): Promise<CancelResult> {
    if (opts.all) {
      const slugs = [...this.sessions.keys()];
      // Cancel in parallel — each cancelOne awaits its child's exit event
      // independently, so serial would block the second behind the first's
      // setImmediate (also slow with fake timers in tests).
      const results = await Promise.all(slugs.map((s) => this.cancelOne(s)));
      const cancelled = slugs.filter((_, i) => results[i]);
      return { cancelled };
    }
    if (opts.slug !== undefined) {
      const ok = await this.cancelOne(opts.slug);
      return { cancelled: ok ? [opts.slug] : [] };
    }
    if (this.sessions.size === 0) return { cancelled: [] };
    if (this.sessions.size > 1) {
      throw new Error('multiple sleeps active; specify slug or pass all=true');
    }
    const onlySlug = [...this.sessions.keys()][0]!;
    const ok = await this.cancelOne(onlySlug);
    return { cancelled: ok ? [onlySlug] : [] };
  }

  private async cancelOne(slug: string): Promise<boolean> {
    const session = this.sessions.get(slug);
    if (!session || session.terminated) return false;
    session.terminated = true;
    clearTimeout(session.maxDurationTimer);
    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = (): void => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      session.child.once('exit', done);
      session.child.kill('SIGTERM');
      setTimeout(done, 5_000);
    });
    void this.deps.notify(
      `\u{1F6D1} sleep cancelled — ${slug}. log: ${session.worktreePath}/.kuroboto-sleep.log`,
    );
    this.sessions.delete(slug);
    this.maybeRestoreGaming();
    return true;
  }

  private handleChildExit(
    slug: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const session = this.sessions.get(slug);
    if (!session || session.terminated) return;
    session.terminated = true;
    clearTimeout(session.maxDurationTimer);
    if (code === 0) {
      void (async () => {
        try {
          await this.deps.onSuccess({
            slug: session.slug,
            branch: session.branch,
            worktreePath: session.worktreePath,
            startedAt: session.startedAt,
            expectedEndAt: session.expectedEndAt,
            prompt: session.prompt,
            repo: session.repo,
          });
        } catch (e) {
          void this.deps.notify(
            `⚠️ sleep onSuccess hook failed for ${slug}: ${(e as Error).message}`,
          );
        } finally {
          this.sessions.delete(slug);
          this.maybeRestoreGaming();
        }
      })();
    } else {
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      void this.deps.notify(
        `❌ sleep failed — ${slug} — ${reason}. log: ${session.worktreePath}/.kuroboto-sleep.log`,
      );
      if (this.deps.notifyDesktop) {
        void this.deps.notifyDesktop({
          title: 'kuroboto: sleep error',
          body: `${slug}: ${reason}`,
          level: 'error',
        });
      }
      this.sessions.delete(slug);
      this.maybeRestoreGaming();
    }
  }

  private handleTimeout(slug: string): void {
    const session = this.sessions.get(slug);
    if (!session || session.terminated) return;
    session.terminated = true;
    session.child.kill('SIGTERM');
    void this.deps.notify(
      `⏰ sleep timed out — ${slug}. log: ${session.worktreePath}/.kuroboto-sleep.log. PR not created.`,
    );
    if (this.deps.notifyDesktop) {
      void this.deps.notifyDesktop({
        title: 'kuroboto: sleep timeout',
        body: `${slug}: ran past max duration; no PR`,
        level: 'error',
      });
    }
    this.sessions.delete(slug);
    this.maybeRestoreGaming();
  }

  private maybeRestoreGaming(): void {
    if (this.sessions.size > 0) return;
    const prior = this.firstSessionGamingPrior;
    this.firstSessionGamingPrior = null;
    if (!prior) return;
    if (!prior.active) {
      this.deps.gaming.cancel();
      return;
    }
    if (prior.until === null) {
      // Was on with no timer — leave on.
      if (!this.deps.gaming.snapshot().active) this.deps.gaming.arm();
      return;
    }
    // Was on with a timer — re-arm with remaining duration.
    const remainingMs = prior.until - Date.now();
    if (remainingMs > 0) {
      this.deps.gaming.cancel();
      this.deps.gaming.arm(remainingMs);
    } else {
      this.deps.gaming.cancel();
    }
  }
}

function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}
