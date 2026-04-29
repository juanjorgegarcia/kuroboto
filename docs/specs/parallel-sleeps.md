# Parallel sleep sessions

> Status: planned. Spec D — unblocks running multiple `kuroboto sleeping start` invocations concurrently.

## Problem

Today the daemon enforces single-sleep:

```ts
// src/daemon/sleeping.ts
if (this.session) throw new Error('a sleep session is already active');
```

This means:
- Two specs that are designed to be orthogonal (e.g., Specs A and B in the bot UX overhaul) still must run sequentially — first PR has to merge before the second can dispatch.
- Cross-repo work is also serialized: if the user has a sleep running on kuroboto, they can't dispatch one on PoeAltCrafter at the same time, even though there's no resource conflict.
- Wall-clock time scales linearly with number of features instead of staying bounded by per-feature time.

The fix is to let the daemon hold N concurrent sleep sessions, capped by config to keep token spend and process count bounded.

## Solution

Replace `this.session: Session | undefined` with `this.sessions: Map<string, Session>` keyed by slug. Each entry is the same `Session` shape as today (worktree path, branch, child process, started-at, max-duration timer).

```
SleepingOrchestrator (today)         SleepingOrchestrator (after)
  session?: Session                    sessions: Map<slug, Session>
  start(req)  // throws if active      start(req)  // throws only if cap reached
  cancel()                             cancel(slug?)  // single or all
                                       snapshot()  → { active: SessionSnap[], capacity }
```

`policy.maxConcurrentSleeps: number` (default 6) caps the Map size. The daemon refuses the (N+1)th dispatch with a clear error.

The `kuroboto sleeping` CLI is updated to handle the multi case naturally.

## Files

**Modify:**
- `src/daemon/sleeping.ts` — `Session | undefined` → `Map<string, Session>`. `start()` throws only when `sessions.size >= maxConcurrentSleeps`. `cancel(slug?)` cancels one (or all if no slug). `snapshot()` returns array of session summaries plus `capacity`.
- `src/daemon/sleepFinish.ts` — receives `slug` (already does via session ref) and removes only its session from the Map. Existing `notifyDesktop` (Spec C) and `channel.sendNotification` calls remain unchanged — both already include the slug in their bodies.
- `src/daemon/routes.ts`:
  - `POST /v1/sleeping` (start) — same payload; returns 429 with `{ error: 'capacity reached', cap, active: [...] }` if at cap.
  - `GET /v1/sleeping` — returns `{ active: SessionSnap[], capacity }` (was a single `SessionSnap | null`).
  - `POST /v1/sleeping/cancel` — body `{ slug?: string, all?: boolean }`. Without either, cancels the most recently started.
- `src/cli/sleeping.ts`:
  - `kuroboto sleeping status` — always lists all active (compact format below); `(no active sleeps)` when empty.
  - `kuroboto sleeping cancel` — no args → cancels most recent (with prompted confirmation showing slug); `<slug>` → cancels that one without prompt; `--all` → cancels all (with confirmation).
- `src/config/schema.ts` — add `maxConcurrentSleeps: z.number().int().min(1).default(6)` to `PolicyConfig`.
- `src/daemon/lifecycle.ts` (or wherever shutdown drains) — iterate `sessions` and cancel each on SIGTERM (existing behavior, applied N times).
- `test/unit/sleeping.test.ts` (extend) — multi-session orchestration cases.
- `test/integration/daemon.test.ts` (extend) — concurrent dispatch + status + cancel scenarios.

## Behavior details

**Status output (single):**
```
sleep: 1 active (cap 3)
  • desktop-notifications-on-sleep-finish-ltf3hi   1h 47m remaining
```

**Status output (multiple):**
```
sleep: 2 active (cap 3)
  • desktop-notifications-on-sleep-finish-ltf3hi   1h 47m remaining
  • parallel-sleeps-abc123                         1h 12m remaining
```

**Status output (empty):**
```
sleep: idle (cap 3)
```

**Cancel UX:**

| Invocation | Behavior |
|---|---|
| `kuroboto sleeping cancel` (no active) | "(no active sleeps)" exits 0 |
| `kuroboto sleeping cancel` (one active) | Prompts: "cancel `<slug>`? [y/N]" — slug always shown |
| `kuroboto sleeping cancel` (multiple active) | Prompts: "cancel most recent (`<slug>`)? [y/N]" — slug always shown |
| `kuroboto sleeping cancel <slug>` | Cancels that specific slug; no prompt (user typed slug explicitly) |
| `kuroboto sleeping cancel --all` (any count) | Prompts: "cancel all N: `<slug1>, <slug2>, ...`? [y/N]" — all slugs listed |
| `kuroboto sleeping cancel <slug>` (slug not found) | Error: "no active sleep with slug '<slug>'" exits 1 |
| Non-interactive shell (no TTY) | All prompts auto-fail; user must pass `--yes` flag to bypass (added in v1) |

**Capacity reached:**

When `sessions.size >= maxConcurrentSleeps`, `POST /v1/sleeping` returns:

```json
{
  "error": "capacity reached",
  "cap": 3,
  "active": [
    { "slug": "...", "remainingMs": ... },
    ...
  ]
}
```

CLI surfaces as:
```
sleep refused: capacity reached (3/3 active)
  • desktop-notifications-on-sleep-finish-ltf3hi   1h 47m
  • parallel-sleeps-abc123                         1h 12m
  • foo-bar-xyz789                                 50m

cancel one with `kuroboto sleeping cancel <slug>` or raise the cap in config (`policy.maxConcurrentSleeps`).
```

**Cross-sleep isolation:**
- Each session has its own worktree and branch (already the case via random suffix in slug).
- Each session has its own child process (independent stdout/stderr).
- Each session's `formatDuration`/timer runs independently.
- The audit log already serializes appends; no concurrency concerns.
- Telegram messages are sent serially through the channel (existing single-thread polling) — no message reordering.

**Same-repo dispatches:** the daemon does **not** prevent two sleeps targeting the same repo. The user is expected to know whether their two specs are orthogonal (à la Specs A+B in the bot UX overhaul). If they're not orthogonal, the second PR will hit merge conflicts — but that's downstream of the daemon's responsibility. A future improvement could warn ("repo X already has 1 active sleep") — out of scope for v1.

**Migration / backwards compat:**
- Existing config (no `maxConcurrentSleeps`) loads with default 6 via Zod.
- Single-sleep callers see no behavior change: `start()` succeeds when 0 active, status shows the one with the same info as today (just with `(cap 3)` annotation), `cancel` without args works on the lone active.
- The `/v1/sleeping` GET response shape changes from `SessionSnap | null` to `{ active: [], capacity }`. **Existing CLI callers** are updated in this PR; **no external API consumers** today, so no version bump.

## Audit

No new `source` values. Existing entries keyed by request/cwd already disambiguate.

## Out of scope (follow-ups, see `docs/specs-backlog.md`)

- **Per-repo lock/warning** — refuse a second dispatch on the same repo, or warn before allowing.
- **Priority/queue** — when at cap, queue the new dispatch instead of refusing.
- **Resource-aware cap** — auto-detect a cap from machine cores or memory.
- **Per-session tagging in Telegram** via supergroup topics (already in backlog as the supergroup spec).
- **Auto-cleanup of finished worktrees** (already in backlog).
- **Morpheus run tracking** (`~/.morpheus-runs.jsonl`) — workflow-stage tracking, complementary to the daemon's sleep tracking.

## Test plan

**Unit (`sleeping.test.ts` extension):**
- `start()` twice with different slugs → both `sessions` entries present
- `start()` when `sessions.size === maxConcurrentSleeps` → throws "capacity reached"
- `cancel(slug)` → removes only the matching session, others continue
- `cancel()` no args + 1 active → cancels it
- `cancel()` no args + 2 active → throws (CLI handles the "most recent" prompt; orchestrator API requires explicit slug or `all`)
- `cancel({ all: true })` → cancels all, sessions Map is empty
- `snapshot()` returns `{ active: [], capacity }` shape with all sessions
- Sleep finish removes only the finishing session (pre-existing single-session test extended)

**Unit (`schema.test.ts`):**
- `maxConcurrentSleeps` defaults to 3 when omitted
- `maxConcurrentSleeps: 0` rejected (min 1)
- `maxConcurrentSleeps: 'three'` rejected (not number)

**Integration (`daemon.test.ts`):**
- Two dispatches → both succeed, `GET /v1/sleeping` returns 2 active
- Three dispatches with cap=3 → all succeed; fourth → 429 with `error: 'capacity reached'` body
- Cancel by slug → only that session is removed
- Cancel `--all` → all sessions removed; subsequent dispatch succeeds
- Sleep finish for one session does not affect the other (mock channel sees both completion notifications, not just one)

**Smoke (post-merge):**
1. `kuroboto sleeping start --plan a.md` → `kuroboto sleeping status` shows 1
2. `kuroboto sleeping start --plan b.md` (different repo or different slug) → `kuroboto sleeping start status` shows 2
3. Set `maxConcurrentSleeps: 2`; dispatch a 3rd → see capacity-reached error with the 2 active listed
4. `kuroboto sleeping cancel <one-slug>` → 1 active, can dispatch again
5. `kuroboto sleeping cancel --all` → idle

## Tasks

1. **M1**: Refactor `SleepingOrchestrator` to `Map<slug, Session>`. Update `start`/`cancel`/`snapshot`. Add `maxConcurrentSleeps` to schema. Unit tests.
2. **M2**: Update `routes.ts` (`POST /v1/sleeping` capacity check, `GET /v1/sleeping` shape, `POST /v1/sleeping/cancel`). Update CLI (`status`, `cancel`). Integration tests.
3. **M3**: Manual smoke + PR.
