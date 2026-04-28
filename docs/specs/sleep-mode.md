# Sleep Mode

> Status: implementing in `feat/sleep-mode`

## Problem

Sometimes the dev wants to fully step away — sleeping, going out for hours — and have
Claude implement an entire plan/prompt autonomously. Wake up to a PR with code review
and test instructions waiting. Gaming mode handles the "I'm here but distracted" case;
sleep mode handles "I'm gone, drive yourself."

## Solution

`kuroboto sleeping start` triggers a fully autonomous orchestration:

1. Daemon creates a git worktree on a new branch (off the configured repo's main/HEAD).
2. Daemon flips gaming on with `gamingAlwaysAsk: []` (auto-allow everything for the duration).
3. Daemon spawns `claude -p "<prompt or plan content>"` with cwd = worktree.
4. Daemon monitors: success on exit-0, fail on non-zero, kill on max-duration timeout.
5. On success: daemon runs `gh pr create` from the worktree, then spawns
   `claude -p "/code-review <PR-URL>"` headless to drop a review comment.
6. Daemon flips gaming back to its prior state and sends a final Telegram notification
   with the PR URL + brief test instructions extracted from the implementation.

State lives in memory only. Daemon restart aborts any in-flight session (consistent
with gaming). Max one sleep session active at a time.

## Public API

### CLI
```
kuroboto sleeping start --prompt "implement X feature" [--repo PATH] [--max 2h]
kuroboto sleeping start --plan path/to/plan.md [--repo PATH] [--max 2h]
kuroboto sleeping cancel       # kill child, leave worktree for inspection
kuroboto sleeping status       # 'idle' or 'running (worktree=<...>, started 18m ago, max 2h)'
```

`--prompt` and `--plan` are mutually exclusive; one is required. `--repo` defaults to
`process.cwd()`. `--max` defaults to `policy.sleepMaxDurationMs` (default 2h).

### HTTP (loopback only, X-Kuroboto-Token required)
```
POST /v1/sleeping     body: { repo: string, plan?: string, prompt?: string, maxDurationMs?: number }
                      → 202 { ok: true, slug, worktreePath, branch, startedAt }
                      → 409 if a sleep is already running

GET  /v1/sleeping     → { active: false } | { active: true, slug, worktreePath, branch,
                                              startedAt, expectedEndAt, plan?: string,
                                              prompt?: string }

DELETE /v1/sleeping   → { ok: true, cancelled: bool, reason: 'idle'|'cancelled' }
```

`plan` in POST is the **content** of the file already read by the CLI (so the daemon
doesn't need filesystem access to the user's plan). `prompt` is the literal prompt string.

### Config (additions)
```jsonc
{
  "policy": {
    "sleepMaxDurationMs": 7200000,           // 2h default
    "sleepWorktreeDir": "~/.kuroboto/worktrees"   // override per platform
  }
}
```

## Slug + branch + worktree naming

- Slug = lowercased first 4-6 words of the prompt OR the basename of the plan file,
  sanitized (`[a-z0-9-]+`), + 6-char random suffix to prevent collisions on retries.
  Example: `implement-billing-flow-x9k2pq`
- Branch: `sleep/<slug>` (e.g. `sleep/implement-billing-flow-x9k2pq`)
- Worktree path: `<sleepWorktreeDir>/<slug>` (e.g. `~/.kuroboto/worktrees/implement-...`)

## Spawn

```
claude -p "<prompt>" --output-format stream-json
        --cwd <worktreePath>
```

For plans, the prompt is generated as:
```
Execute this implementation plan. Follow it task-by-task. Run tests, commit per task,
and create a final summary at the end.

<plan content here>
```

Logs go to `<worktreePath>/.kuroboto-sleep.log` for post-mortem.

## Lifecycle / state machine

```
IDLE → (POST /v1/sleeping) → STARTING (creating worktree, snapshotting gaming, spawning) →
  → RUNNING (child alive)
    → exit 0    → REVIEWING (gh pr create, /code-review)  → DONE      → IDLE
    → exit ≠ 0  → FAILED (notify, leave worktree)                     → IDLE
    → maxDur    → TIMED_OUT (kill child, notify, leave worktree)      → IDLE
    → DELETE    → CANCELLED (kill child, leave worktree)              → IDLE
```

In every terminal state, gaming mode is restored to its prior snapshot.

## Notifications

| Event | Telegram message |
|---|---|
| start | `💤 sleep started — worktree: <slug>, max 2h` |
| success | `✅ sleep done — PR: <url>\n\nTeste: <generated checklist>` |
| failure | `❌ sleep failed — exit <N>. log: <path>` |
| timeout | `⏰ sleep timed out (2h). log: <path>. PR not created.` |
| cancelled | `🛑 sleep cancelled. log: <path>` |

## Test instructions generation

After PR creation, daemon reads the diff via `gh pr diff <num>` and extracts:
- New CLI commands (lines like `program.command(...)`) → list those
- New endpoints (lines like `app.(get|post|put|delete)`) → list those
- Modified test files → "tests added/updated: ..."

These get appended to the success notification. Best-effort; if extraction fails, send
just the URL.

## Invariants

- Max one sleep session at a time (`POST /v1/sleeping` returns 409 if one is active)
- Daemon restart cancels any active session (state is in memory only)
- Worktree is left intact on success/failure/timeout for the dev to inspect — only
  removed manually via `git worktree remove` (kuroboto does NOT auto-clean to avoid
  destroying work)
- Cancel does NOT auto-clean worktree (same reason)
- Gaming mode is restored to its prior snapshot on every terminal transition

## Out of scope (follow-ups)

- Mid-sleep heartbeat / progress updates (we only get `start` and `end` notifications;
  intermediate Stop hooks could feed status, but that's complex)
- Multi-sleep (one user, multiple parallel sleeps in different worktrees)
- Auto-merging on success (always leaves the PR open for human review — by design)
- Resume-after-restart (state is intentionally ephemeral)

## Test plan

**Unit:**
- `worktree.test.ts`: createWorktree creates dir + branch off HEAD; removeWorktree cleans up; slugify produces valid identifier; collision detection for branch/dir
- `sleeping.test.ts`: spawn flow with mocked child_process; success/fail/timeout transitions; gaming snapshot+restore; max-duration timer cancellation; concurrent-start rejection

**Integration (`daemon.test.ts`):**
- `POST /v1/sleeping` returns 202 with slug; `GET` reflects active; `DELETE` returns cancelled
- `POST /v1/sleeping` returns 409 if one is already active
- Mocked spawn: success path calls gh pr create + flips gaming back

**Smoke (manual, runs real Claude):**
- Cd into a small test repo
- `kuroboto sleeping start --prompt "add a print('sleep test') line to README.md and commit"`
- Wait
- Confirm: PR created, code review comment added, gaming restored, Telegram notification with URL
