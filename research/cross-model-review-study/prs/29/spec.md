# Bug C watchdog — daemon auto-recovery

> Status: planned. Spec G. Targets the long-standing "Bug C" — daemon dies silently and stays dead until the user notices and runs `kuroboto ohayo`. PR #26 covered JS exceptions via `installCrashHandlers`; this spec covers everything that bypasses Node-level handlers (external SIGKILL, OOM killer, OS sleep/hibernate, segfault, power loss).

## Problem

The daemon is a single long-lived Node process. Today it dies for several reasons:

1. **JS exception** — covered by `installCrashHandlers` in PR #26: writes `daemon.crash.log` before exit. Solved.
2. **External SIGKILL** — Windows logoff, `taskkill /F`, OOM killer, force-quit, `kill -9`. Bypasses every Node handler. No log, no signal, daemon just vanishes.
3. **OS sleep / hibernate** — laptop closes lid; on wake, Telegram polling connection is dead and never recovers in some cases. Process is alive but functionally dead.
4. **Native crash** — segfault inside libuv or a native dependency. No JS-level recovery.
5. **Power loss** — same as SIGKILL from the daemon's perspective.

Observed at least 3× in the 2026-04-29 session: daemon disappeared between 10–30 min after start with **no entry** in `daemon.log` (no shutdown line) and **no entry** in `daemon.crash.log` (PR #26's coverage). The only evidence was the *absence* of activity. User had to manually re-run `kuroboto ohayo` each time, losing whatever in-flight Telegram polling state existed.

The fix is a separate **watchdog process** that supervises the daemon, detects death instantly via parent-child `child.on('exit')`, and respawns with bounded retries.

## Solution

`kuroboto start --detach` spawns a watchdog process (detached). The watchdog spawns the daemon as **its own child**, listens for `exit`, and respawns with exponential backoff. The watchdog stays simple (~200 LOC, no Telegram polling, no HTTP server, no business logic) so its own failure surface is minimal.

Auto-recovery is **default-on**. There is no "opt-in flag" — Bug C is the entire reason the watchdog exists; making it opt-in would underdeliver on the feature. An opt-out flag `--no-watchdog` is provided for debugging (foreground / direct daemon spawn, current behavior).

In-flight sleeps that die alongside the daemon are **out of scope for v1**. This spec focuses on daemon-level recovery only. Sleep recovery (persistence, re-attach) is deferred to a follow-up spec — see "Future / v2 roadmap" below — and informed by empirical data this v1 will produce.

## Architecture

```
kuroboto start --detach
        │ spawn detached
        ▼
┌──────────────────┐  child.spawn(daemon)   ┌─────────────────────┐
│ watchdog process │ ──────────────────────▶│ daemon process      │
│ (~200 LOC)       │  child.on('exit')      │ (existing lifecycle)│
│  - parent-child  │ ◀──────────────────────┤                     │
│  - backoff       │  poll /v1/health       │ HTTP :47891         │
│  - notify        │ ◀──────────────────────┤                     │
└──────┬───────────┘                        └─────────────────────┘
       │ writes
       ▼
~/.config/kuroboto/watchdog.pid
~/.config/kuroboto/watchdog.log
```

State machine (watchdog):

```
   [STARTING_DAEMON] ──spawn ok──▶ [WAITING_HEALTHY] ──/health 200──▶ [RUNNING]
          │                              │                                 │
          │ spawn fail                   │ timeout 10s                     │ child exit
          ▼                              ▼                                 ▼
   [GIVING_UP]                    [GIVING_UP]                    everHealthy?
                                                                          │
                                                       ┌──────────────────┴────────────────┐
                                                       ▼                                   ▼
                                                  no → [GIVING_UP]                 yes → backoff,
                                                                                          re-spawn,
                                                                                          back to
                                                                                  [STARTING_DAEMON]
```

`everHealthy` is a single boolean per watchdog lifetime: once the daemon's `/v1/health` returns 200 even one time, every subsequent crash is treated as runtime (respawn-eligible). A daemon that never reached healthy is a startup failure (config wrong, port in use) and should not loop.

## Files

**Create:**
- `src/watchdog/index.ts` — entry point. Reads config (port, channel for notifications), spawns daemon as child, manages state machine, handles SIGTERM cleanup.
- `src/watchdog/policy.ts` — pure functions, easy to unit test:
  - `nextBackoff(attempt: number): number` — returns ms (1000, 2000, 4000, 8000, 16000, 30000, 30000…).
  - `shouldRespawn(state: WatchdogState): { respawn: boolean; reason: string }` — encapsulates the everHealthy / max-retries / window logic.
- `src/watchdog/notify.ts` — minimal Telegram sender (subset of `TelegramApi.sendMessage`, plus topic context for `kuroboto-system`). Cannot reuse `TelegramChannel` because the daemon may be dead and the watchdog must remain independent. Best-effort: failures log to watchdog.log and continue.
- `test/unit/watchdog/policy.test.ts`
- `test/unit/watchdog/lifecycle.test.ts`
- `test/integration/watchdog-bugC.test.ts`
- `test/integration/watchdog-startup.test.ts`
- `test/integration/watchdog-stop.test.ts`

**Modify:**
- `src/cli/start.ts` — `startDetached` now spawns the watchdog (not the daemon directly). The `--no-watchdog` flag preserves the legacy direct-spawn path for debug/foreground. Foreground `startForeground` is unchanged.
- `src/cli/stop.ts` — read `WATCHDOG_PID_FILE` first; if present, SIGTERM the watchdog and let it clean up the daemon. If absent (legacy or `--no-watchdog`), fall back to current direct-daemon-kill path.
- `src/cli/status.ts` — show both processes. Detect and clearly flag the split-brain case where watchdog is dead but daemon is alive (rare; happens if the watchdog was killed by hand).
- `src/config/paths.ts` — add `WATCHDOG_PID_FILE = path.join(CONFIG_DIR, 'watchdog.pid')` and `WATCHDOG_LOG_FILE = path.join(CONFIG_DIR, 'watchdog.log')`.
- `src/daemon/lifecycle.ts` — at startup, scan `~/.kuroboto/worktrees/sleep-*` for orphaned worktrees (see "Sleep behavior on crash" below). Notify if found.

## Behavior details

### Startup flow

1. `kuroboto start --detach` runs `checkHealth()`. If daemon already alive → "já está rodando", return.
2. Otherwise spawn the **watchdog** detached, sharing `STARTUP_LOG_FILE` for stdout/stderr (same path used by PR #23 to surface startup errors).
3. Watchdog writes `WATCHDOG_PID_FILE`.
4. Watchdog spawns the daemon as its child, again sharing `STARTUP_LOG_FILE` stdio so any startup error is captured for the parent CLI to tail.
5. Watchdog enters `WAITING_HEALTHY`: polls `http://127.0.0.1:<port>/v1/health` every 250ms for up to 10s.
6. On 200 within 10s → `everHealthy = true`, state → `RUNNING`. Telegram notif `✅ kuroboto online` is sent by the daemon itself (existing behavior). No additional notif from the watchdog on first start.
7. On 10s timeout without 200 → `GIVING_UP`. Watchdog sends notif (best-effort) `❌ daemon não respondeu em 10s — investigar config`, exits non-zero. The CLI parent times out its own wait, reads `STARTUP_LOG_FILE` tail, and prints the error — same UX as PR #23 today.

### Runtime crash flow (Bug C)

1. Daemon dies (any cause: SIGKILL, OOM, segfault, escaped JS exception).
2. Watchdog receives `child.on('exit', (code, signal) => ...)` instantly.
3. `shouldRespawn` consults state:
   - `everHealthy === false` → `{ respawn: false, reason: 'startup-failure' }`. Notif + exit. (Already covered by startup flow above; this path is for the rare case where /health 200'd then immediately died — still treat as runtime since `everHealthy === true`.)
   - 5 respawns within the last 60s (rolling window — count of respawn timestamps where `now - ts < 60_000`) and none reached "healthy ≥30s consecutive" → `{ respawn: false, reason: 'gave-up' }`. Notif `❌ watchdog deu up — 5 falhas em 60s. Última: <signal/code>. Rode kuroboto ohayo quando puder.`. Exits.
   - Otherwise → `{ respawn: true }`. Increment attempt, wait `nextBackoff(attempt)`, spawn again. State → `STARTING_DAEMON`.
4. Per respawn: notif `🔄 daemon respawnado (#N) — exit code <X> / signal <Y>` to the `kuroboto-system` topic if forumMode is on; main chat otherwise.
5. New daemon healthy ≥30s consecutively → reset `attempt = 0`. The 30s threshold means "the daemon stabilized" and unlocks the full backoff budget for any future crash.

### Stop flow

1. `kuroboto stop` reads `WATCHDOG_PID_FILE`. If present → SIGTERM the watchdog. Wait up to 10s for both PID files to disappear.
2. Watchdog SIGTERM handler: SIGTERM the daemon child; wait up to 5s; SIGKILL fallback. Delete `WATCHDOG_PID_FILE` and `PID_FILE`. Exit cleanly.
3. If `WATCHDOG_PID_FILE` is absent (legacy install pre-watchdog, or `--no-watchdog` was used): fall back to current `stop.ts` behavior (read `PID_FILE`, SIGTERM the daemon, polling).

### Sleep behavior on crash (v1 scope)

Sleeps spawned via `SleepingOrchestrator` are children of the **daemon**, not of the watchdog. When the daemon dies, sleep behavior is platform-dependent:

- **Windows**: child cascade-dies via job object inheritance — sleep is killed too. Worktree remains, branch `sleep/<slug>` exists, no PR opened.
- **Linux/macOS**: child may survive (re-parented to init/launchd) but its stdout pipe is orphaned, so `[[KUROBOTO]]` markers are lost. The respawned daemon has no in-memory record of the sleep.

v1 does not attempt to attach to or persist these. Instead, the **respawned daemon scans worktrees on startup**:

- Look for directories matching `~/.kuroboto/worktrees/sleep-*`.
- For each, check the corresponding `sleep/<slug>` branch: if no open PR exists for it AND the worktree's mtime is older than 5 minutes (indicating no recent activity), notify `⚠️ sleep <slug> ficou órfão durante restart; investigar manualmente`.
- The user runs `kuroboto sleeping cancel <slug>` (existing) or `kuroboto sleeping cleanup` (existing, fixed in PR #28) to reclaim.

This is the **scope-limited v1 path**. Empirical observation in production will tell us whether sleeps cascade-die universally on Windows, frequently survive on Linux, etc. — input for v2 design.

### Configuration

No new config keys. `--no-watchdog` is a CLI flag on `start --detach` only. The watchdog reads `~/.config/kuroboto/config.json` once at its own startup (chatId/token/port) and **does not reload across respawns**. If the user edits config while the watchdog is running, they should `kuroboto stop && kuroboto start --detach` to pick it up — same model as the daemon today. Avoiding mid-flight reload keeps the watchdog's state machine deterministic.

## Failure modes

| Failure | Behavior |
|---|---|
| Daemon startup crash (port in use, bad token, broken config) | Watchdog stays in `WAITING_HEALTHY`, times out at 10s, notifies, exits != 0. CLI parent surfaces tail of `STARTUP_LOG_FILE` (PR #23 path). |
| Daemon JS uncaughtException/unhandledRejection | `installCrashHandlers` (PR #26) writes `daemon.crash.log` and exits 1. Watchdog detects exit, respawns. The two coverage paths cooperate. |
| Daemon SIGKILL (Windows logoff, taskkill /F, OOM) | Watchdog `child.on('exit', signal: 'SIGKILL')`. Respawns. Exact bug-C path. |
| Daemon hang (deadlock, infinite loop, stuck in syscall) | **Not covered by v1.** Watchdog only reacts to `exit`. Detection requires active health-check + force-kill — separate feature, see backlog. |
| Watchdog hits 5 respawns in 60s | Notif (Telegram + desktop best-effort), append `daemon.crash.log` "watchdog gave up after N attempts", exit. `kuroboto status` thereafter shows everything dead. User runs `kuroboto ohayo`. |
| Watchdog itself crashes | Daemon child cascade-dies (Windows) or is orphaned (Unix). PID files become stale. `kuroboto status` detects (alive PID check) and shows the state. No auto-recovery — watchdog is simple enough that this should be rare; if it happens repeatedly, that's a bug to fix in code, not patch in process. |
| Telegram unreachable during respawn notif | Notif fail logged to `watchdog.log`. Desktop notif fallback (best-effort, swallows errors). Watchdog logic continues unaffected. |
| Port already in use when daemon respawns | Daemon fails startup (bind error). Watchdog sees daemon's exit before /health ever 200's during this respawn cycle. Already-true `everHealthy` from prior cycle still allows another retry, but if 5 of these happen in 60s → gives up. Reasonable: port-in-use is a real condition that won't self-resolve, and gave-up notif tells the user. |
| Stale `WATCHDOG_PID_FILE` from a crashed prior run | `start.ts` checks `isProcessAlive` on the recorded PID before spawning a new watchdog (mirrors current `ensureNoExistingDaemon` logic). Stale → unlink and proceed. |

## Audit

Three new `source` values in `audit.jsonl` (file at `AUDIT_FILE`, written via existing `appendAudit`):

- `watchdog-respawn` — `decision: 'allow'`, `reason: 'exit code N'` or `'signal SIGKILL'`. Per respawn.
- `watchdog-gave-up` — `decision: 'deny'`, `reason: 'N retries in window M'`. Once per gave-up event.
- `watchdog-startup-failure` — `decision: 'deny'`, `reason: '...'`. When daemon never reaches healthy.

Audit entries from the watchdog use a `requestId` of `watchdog:<isotimestamp>` so they don't collide with daemon's permission-decision entries.

## Out of scope (follow-ups)

- **Sleep persistence and recovery (v2)** — persist active sleeps to `~/.config/kuroboto/sleeps.json` (PID, slug, started, expectedEnd). Respawned daemon reads file, checks each PID with `process.kill(pid, 0)`, marks alive ones as "recovered (markers lost)" or dead ones as failed. Cross-platform behavior (cascade vs orphan) gathered from v1 production data informs the design. Watchdog v1 should expose an `onDaemonRespawn(pid)` interface so v2 can plug in non-invasively. Tracking entry: `docs/specs-backlog.md` — "Spec G2 — sleep recovery".
- **Hang detection** — daemon alive but unresponsive (stuck in deadlock, infinite loop). Requires the watchdog to actively poll `/health` continuously, not just rely on `exit`, and force-SIGKILL when N consecutive polls fail. v1 deliberately ignores this case — it's a real but separate failure mode and folding it in here would double the watchdog's complexity.
- **Self-watchdog** — supervising the watchdog itself with another process. Explicitly rejected: the watchdog is small enough that "watch the watchdog" adds more failure surface than it removes. If the watchdog crashes, the user runs `kuroboto ohayo`.
- **OS service integration (NSSM/systemd/launchd)** — wrapping the daemon as a real OS-managed service. Powerful but requires admin/root, OS-specific install steps, and breaks the `npm i -g kuroboto` simplicity. Not aligned with the project's "single binary, user-mode" stance.

## Test plan

### Unit (`policy.test.ts`)

- `nextBackoff(0..6)` returns `[1000, 2000, 4000, 8000, 16000, 30000, 30000]`.
- `shouldRespawn` with `everHealthy: false` → `{ respawn: false, reason: 'startup-failure' }`.
- `shouldRespawn` with 5 attempts in last 60s and none reached healthy ≥30s → `{ respawn: false, reason: 'gave-up' }`.
- `shouldRespawn` with attempts that include a "healthy ≥30s" reset → counter is back to 0, respawn allowed.
- `shouldRespawn` happy path → `{ respawn: true }`.

### Unit (`lifecycle.test.ts` — mock `spawn`, mock `fetch`, mock `fs`)

- Watchdog spawns daemon, child exits before /health ever 200's → does not respawn, exits non-zero.
- Watchdog spawns daemon, /health 200's, child exits later → respawns after correct backoff delay.
- Watchdog SIGTERM handler → SIGTERM-then-SIGKILL the child, deletes both PID files.
- Watchdog crash notif goes to `kuroboto-system` topic when `forumMode: true`, main chat otherwise.

### Integration / anti-regression

Each of these references a real bug or PR; the test name carries the reference so a future refactor doesn't silently regress it.

**`watchdog-bugC.test.ts`** — covers the original Bug C from the 2026-04-29 sessions:

- `'respawns after external SIGKILL (bug C from 2026-04-29 sessions)'` — spawn a real foreground daemon process, then `process.kill(daemonPid, 'SIGKILL')`. Assert the watchdog (under test) detects the exit, waits ~1s backoff, respawns, and the new daemon's `/health` returns 200 within 10s.
- `'respawns after daemon JS crash + crashHandlers fired (bug C path 2 — PR #26 integration)'` — spawn a daemon-mock that throws after 2s. Assert (a) `daemon.crash.log` contains the entry (PR #26 path still works) AND (b) the watchdog respawned (new path). Cross-coverage of the two.
- `'does NOT respawn when daemon never becomes healthy (avoids infinite loop on bad config)'` — daemon-mock that exits immediately on startup. Assert watchdog gives up without retrying, and `daemon.crash.log` mentions startup failure.
- `'gives up after 5 rapid respawns in 60s window'` — daemon-mock that exits 1s after each healthy check. Assert: 5 respawns happen, then `watchdog-gave-up` audit entry, then watchdog exit non-zero.

**`watchdog-startup.test.ts`** — covers PR #23 regression:

- `'surfaces startup errors via STARTUP_LOG_FILE (PR #23 regression coverage)'` — start with a config that fails to bind (port already in use). Assert the CLI parent receives the error with tail of `STARTUP_LOG_FILE` formatted the same way as today.
- `'falls back to direct daemon spawn with --no-watchdog flag'` — assert legacy path: no watchdog process, only daemon, behaves like pre-spec.

**`watchdog-stop.test.ts`** — covers stop-flow correctness:

- `'kuroboto stop kills both watchdog and daemon, cleans both PID files'`.
- `'kuroboto stop with stale watchdog PID file falls back to direct daemon kill (legacy path)'`.
- `'kuroboto stop times out after 10s if watchdog hangs'` — error path; assert clear error to user.

### Manual smoke (post-merge)

1. `kuroboto start --detach` → `kuroboto status` shows `watchdog: alive (PID=A)` and `daemon: alive (PID=B)`.
2. `taskkill /F /PID <B>` (Windows) or `kill -9 <B>` (Unix) → Telegram receives `🔄 daemon respawnado (#1)` within ~1–2 seconds; status reports a new daemon PID.
3. Loop-kill the daemon 6× rapidly within 60s → after the 5th, `❌ watchdog deu up` notif arrives, status shows everything dead.
4. `kuroboto stop` → both processes terminate in order, PID files cleaned.
5. Edit config to set `daemon.port` to an in-use port. `kuroboto start --detach` → expect clear startup error with log tail, no infinite respawn loop.
6. `kuroboto start --detach --no-watchdog` → only daemon spawns; legacy behavior preserved; status correctly shows `watchdog: (none)` without flagging it as a problem.

## Tasks (milestones)

1. **M1**: `policy.ts` (pure) + `policy.test.ts`. `paths.ts` adds `WATCHDOG_PID_FILE` and `WATCHDOG_LOG_FILE`. No daemon code touched yet. Mergeable on its own.
2. **M2**: `index.ts` (watchdog runtime) + `notify.ts` (minimal Telegram client) + `lifecycle.test.ts`. Functional standalone — can be exercised manually by running it directly. No CLI integration yet.
3. **M3**: Wire into `start.ts`, `stop.ts`, `status.ts`. Daemon-side worktree-orphan scan in `lifecycle.ts`. All anti-regression integration tests. Manual smoke. PR.
