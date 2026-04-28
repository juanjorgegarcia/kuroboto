import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { GamingState } from './gaming.js';
import { slugify } from './worktree.js';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface SleepingDeps {
  spawn: SpawnFn;
  gaming: GamingState;
  notify: (msg: string) => Promise<void>;
  audit: (entry: Record<string, unknown>) => Promise<void>;
  createWorktree: (repo: string, branch: string, dir: string) => Promise<void>;
  removeWorktree: (repo: string, dir: string) => Promise<void>;
  onSuccess: (session: SleepingSession) => Promise<void>;
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

export type SleepingSnapshot =
  | { active: false }
  | {
      active: true;
      slug: string;
      branch: string;
      worktreePath: string;
      startedAt: number;
      expectedEndAt: number;
    };

interface InternalSession extends SleepingSession {
  child: ChildProcess;
  maxDurationTimer: NodeJS.Timeout;
  gamingPriorActive: boolean;
  terminated: boolean;
}

const PLAN_INTRO =
  'Execute this implementation plan. Follow it task-by-task. Run tests, commit per task, and create a final summary at the end.\n\n';

export class SleepingOrchestrator {
  private session: InternalSession | null = null;

  constructor(private readonly deps: SleepingDeps) {}

  snapshot(): SleepingSnapshot {
    if (!this.session) return { active: false };
    return {
      active: true,
      slug: this.session.slug,
      branch: this.session.branch,
      worktreePath: this.session.worktreePath,
      startedAt: this.session.startedAt,
      expectedEndAt: this.session.expectedEndAt,
    };
  }

  async start(req: SleepingStartRequest): Promise<SleepingSession> {
    if (this.session) throw new Error('a sleep session is already active');
    if (!req.prompt && !req.plan) throw new Error('prompt or plan required');
    if (req.prompt && req.plan) throw new Error('prompt and plan are mutually exclusive');

    const seed = req.prompt ?? req.plan ?? '';
    const slug = slugify(seed);
    const branch = `sleep/${slug}`;
    const worktreePath = `${req.workRoot}/${slug}`;
    const finalPrompt = req.plan ? PLAN_INTRO + req.plan : (req.prompt as string);

    await this.deps.createWorktree(req.repo, branch, worktreePath);

    const gamingPriorActive = this.deps.gaming.snapshot().active;
    if (!gamingPriorActive) this.deps.gaming.arm();

    const startedAt = Date.now();
    const expectedEndAt = startedAt + req.maxDurationMs;

    const child = this.deps.spawn('claude', ['-p', finalPrompt], { cwd: worktreePath });

    const maxDurationTimer = setTimeout(() => {
      this.handleTimeout();
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
      gamingPriorActive,
      terminated: false,
    };
    this.session = session;

    child.on('exit', (code, signal) => {
      this.handleChildExit(session, code, signal);
    });

    void this.deps.notify(`\u{1F4A4} sleep started — worktree: ${slug}, max ${formatDuration(req.maxDurationMs)}`);
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

  async cancel(): Promise<boolean> {
    if (!this.session) return false;
    const session = this.session;
    if (session.terminated) return false;
    session.terminated = true;
    clearTimeout(session.maxDurationTimer);
    session.child.kill('SIGTERM');
    void this.deps.notify(`\u{1F6D1} sleep cancelled. log: ${session.worktreePath}/.kuroboto-sleep.log`);
    this.restoreGaming(session.gamingPriorActive);
    this.session = null;
    return true;
  }

  private handleChildExit(
    session: InternalSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (session.terminated) return;
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
            `⚠️ sleep onSuccess hook failed: ${(e as Error).message}`,
          );
        }
      })();
    } else {
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      void this.deps.notify(
        `❌ sleep failed — ${reason}. log: ${session.worktreePath}/.kuroboto-sleep.log`,
      );
    }
    this.restoreGaming(session.gamingPriorActive);
    if (this.session === session) this.session = null;
  }

  private handleTimeout(): void {
    if (!this.session || this.session.terminated) return;
    const session = this.session;
    session.terminated = true;
    session.child.kill('SIGTERM');
    void this.deps.notify(
      `⏰ sleep timed out. log: ${session.worktreePath}/.kuroboto-sleep.log. PR not created.`,
    );
    this.restoreGaming(session.gamingPriorActive);
    this.session = null;
  }

  private restoreGaming(priorActive: boolean): void {
    if (priorActive) {
      if (!this.deps.gaming.snapshot().active) this.deps.gaming.arm();
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
