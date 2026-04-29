# Daemon health UI — `kuroboto status` enriched

> Status: planned. Spec H. Promotes `kuroboto status` from a 4-line liveness check into the canonical "what is my daemon doing right now" surface. Triggered by a confirmed bug observed 2026-04-29: `kuroboto gaming on` succeeds but the next `kuroboto status` does not surface gaming state, hiding the result. Backend already exposes the data; the CLI throws it away.

## Problem

Current `kuroboto status` (`src/cli/status.ts`) shows: PID liveness, HTTP health (`uptime`, `pending`), `mode` read directly from disk, and which Claude Code hooks are installed. That's it.

The daemon already tracks much more state — gaming, active sleeps with timers, registered PTY clients, topic mappings — and exposes most of it via dedicated endpoints (`/v1/gaming`, `/v1/sleeping`, `/v1/inject-clients`). None of that is visible in the canonical "give me a snapshot" command.

Confirmed in production 2026-04-29:

```
$ kuroboto status
  daemon: alive (PID=20652)
  health: ok uptime=2850s pending=0
  mode: here
  hooks: Notification, PreToolUse, Stop

$ kuroboto gaming on
gaming on (no timer — off only via `kuroboto gaming off`)

$ kuroboto status
  (identical output — no indication gaming is armed)
```

The information is in the daemon (`/v1/gaming` returns `{ active: true, until: null }`); the CLI just doesn't ask. There is also a latent consistency bug: `mode` is read from `~/.config/kuroboto/state.json` directly via `loadMode()`, ignoring whatever the daemon has in memory. If the two diverge (e.g., during a write), the CLI lies.

The fix is a richer, single-shot `kuroboto status` that queries the daemon for everything, falls back gracefully when the daemon is offline, and supports `--json` for scripting and `--watch` for live monitoring.

## Solution

Three pieces:

1. **New endpoint `GET /v1/status`** returns the full daemon state in one response. `/v1/health` shrinks to `{ ok, uptimeSec }` — pure liveness, suitable for the watchdog (Spec G) polling loop.
2. **`kuroboto status` rewritten** as a single command that aggregates daemon state + local-only info (watchdog PID file, hooks settings, config path) and renders via pure formatter functions.
3. **Flags:** `--json` (machine-readable), `--watch [N]` (live refresh), `--quiet` (one-liner liveness for scripts).

The single-command approach won out over per-domain subcommands (`kuroboto sleeps`, `kuroboto gaming`) because the primary use case is "glance and check everything" — splitting forces the user to remember 5 commands. Existing subcommands (`kuroboto gaming on/off`, `kuroboto sleeping start`) stay as **mutators**; `status` is the read surface.

The endpoint split (rather than fattening `/v1/health`) decouples liveness probes from display payload. The watchdog (Spec G) polls `/v1/health` continuously; keeping that endpoint trivial means future status growth doesn't penalize the watchdog hot path.

## Architecture

```
        ┌──────────────────────────────────────┐
        │ kuroboto status [--json|--watch|...] │
        └────────────────┬─────────────────────┘
                         │
           ┌─────────────┼──────────────┬───────────────────┐
           │             │              │                   │
           ▼             ▼              ▼                   ▼
    GET /v1/status  WATCHDOG_PID_FILE  ~/.claude/        CONFIG_FILE
    (auth required) (local read)      settings.json     (path string)
           │             │              │                   │
           └─────────────┴──────┬───────┴───────────────────┘
                                ▼
                  ┌─────────────────────────┐
                  │ statusFormat.ts (pure)  │
                  │  - formatHumanReadable  │
                  │  - formatJson           │
                  │  - formatQuiet          │
                  └─────────────────────────┘
                                │
                                ▼
                            stdout
```

`/v1/health` (shrunk) and `/v1/status` (new) both bind to loopback only and inherit the existing auth model: `/health` stays auth-bypass (liveness probe should be free), `/status` requires the standard `X-Kuroboto-Token` header.

## Files

**Create:**
- `src/cli/statusFormat.ts` — pure formatter functions and humanization helpers. No I/O, no side effects.
- `test/unit/statusFormat.test.ts` — covers helpers (`humanizeDuration`, `formatCountdown`, `truncatePath`) and each formatter against fixtures.
- `test/integration/statusCommand.test.ts` — end-to-end tests covering all anti-regression cases.

**Modify:**
- `src/daemon/routes.ts`:
  - Shrink `GET /v1/health` to `{ ok: true, uptimeSec }`. **This is a breaking change** for any existing client of `/v1/health` that consumed `pending`/`mode`/`gaming` from it. Today the only consumer is `src/cli/util.ts:checkHealth()`, used by `cli/status.ts` and `cli/start.ts`; both are updated in this spec.
  - Add `GET /v1/status` returning the full state shape (see Schema below).
- `src/cli/util.ts`:
  - `HealthData` interface narrows to `{ ok: boolean; uptimeSec: number }`.
  - New `StatusData` interface mirroring the new endpoint shape.
  - New `fetchStatus(timeoutMs?): Promise<StatusResult>` — parallel to `checkHealth` but with auth header from loaded config.
- `src/cli/status.ts`:
  - Parse flags via existing CLI parser convention (whatever pattern `start.ts` etc. use).
  - Aggregate: `Promise.allSettled([readPid, readWatchdogPid, fetchStatus, detectInstalledHooks])`.
  - Delegate output to `statusFormat.ts`.
  - `--watch` loop with ANSI clear; SIGINT handler for clean exit.

## Schema (StatusResponse)

```ts
interface StatusResponse {
  daemon: {
    pid: number;
    uptimeSec: number;
    startedAt: string;        // ISO timestamp
    hostname: string;
    port: number;
  };
  pending: {
    permissions: number;      // ctx.pending.size()
    notifications: number;    // ctx.pendingNotifications.size()
    replies: number;          // ctx.pendingReplies.size()
  };
  mode: 'here' | 'away';
  gaming: { active: boolean; until: number | null };  // ms epoch
  sleeping: {
    active: SessionSnap[];    // existing type, slug/branch/worktreePath/startedAt/expectedEndAt
    capacity: number;
  };
  injectClients: ClientListEntry[];  // existing type
  topics?: {                  // omitted entirely if channel.type !== 'telegram'
    forumMode: boolean;
    count: number;            // TopicManager.size() if forumMode, else 0
  };
}
```

Note: `topics.count` requires a new `TopicManager.size()` method (single line). Acceptable surface addition.

## Output mockup (default text)

```
kuroboto status
  config: C:\Users\juanj\.config\kuroboto\config.json
  watchdog: alive (PID=12345)
  daemon: alive (PID=20652) uptime=47m, started 14:23
  health: ok pending=0 pendingNotifications=0
  mode: here
  gaming: armed (sem timer)
  sleeps: 2 active (capacity 3)
    💤 fix-bot-ux            12m ago, expira em 1h48m
    💤 daemon-health-ui      3m ago, expira em 1h57m
  inject clients: 1 registered
    poe-alt-crafter (PID=9876, cwd=C:\Users\juanj\work\PoeAltCrafter)
  topics: forumMode on, 5 mapeados
  hooks: Notification, PreToolUse, Stop
```

Empty states (always rendered, never silently elided):

```
  gaming: off
  sleeps: none active
  inject clients: none
  topics: DM mode (forumMode off)
```

Watchdog row condition: present only if `WATCHDOG_PID_FILE` exists. Pre-Spec G or `--no-watchdog`, the row is simply omitted (not "watchdog: not configured" — silent omission keeps output clean and decouples specs).

## Behavior details

### Flags

- `--json` — emits `JSON.stringify(merged, null, 2)`. Schema is the union of `StatusResponse` plus locally-merged fields (`watchdog`, `hooks`, `configPath`). Snapshot-tested for stability.
- `--watch [N]` — repaints every N seconds (default 1, min 0.5). ANSI clear (`\x1B[2J\x1B[0f`), header includes `(live, refresh ${N}s, Ctrl+C pra sair) — ${time}`. Tolerates daemon transitions: a frame where the daemon dies renders the offline state without aborting the loop. SIGINT exits cleanly.
- `--quiet` — single line `daemon: alive` or `daemon: dead`. Exit code 0/1 for shell pipelines.
- Default text output also exits 1 if daemon is dead (preserves `kuroboto status && do_thing` ergonomics).

### Humanization

- `uptimeSec` rendered via `humanizeDuration`: `<60s → 47s`, `<60m → 47m`, `<24h → 2h15m`, `≥24h → 1d4h`.
- `daemon.startedAt` shown as time-of-day if today, ISO date+time otherwise.
- Sleep `expectedEndAt - now` rendered as countdown: `expira em 1h48m`. Past expiration: `(expirou há Xs — em cleanup?)`.
- Inject client `cwd` truncated at 60 chars with leading `…/` if longer.

### Daemon offline path

When `fetchStatus` fails (ECONNREFUSED, ETIMEDOUT, 401, malformed JSON):

```
kuroboto status
  config: C:\Users\juanj\.config\kuroboto\config.json
  daemon: dead (stale PID=20652)
  health: unreachable (ECONNREFUSED)
  mode: here (from disk — daemon offline)
  hooks: Notification, PreToolUse, Stop
  (daemon offline — gaming/sleeps/inject/topics indisponíveis)
```

Mode falls back to `loadMode()` (disk read) only in this path — explicitly labeled `(from disk — daemon offline)` so the user knows it's a fallback, not authoritative. Other state-derived fields are explicitly omitted with the trailing line.

### Auth handling

`/v1/status` requires `X-Kuroboto-Token`. CLI loads config to grab `daemon.authToken`. If config is missing or malformed:

```
  daemon: alive
  status: auth failed (check config token)
```

Diagnostic message instead of crashing or silent omission.

### Watch mode mechanics

- `setInterval(N * 1000)` driving the render
- Render: clear (`\x1B[2J\x1B[0f`), fetch fresh, format, write
- Fetch errors don't abort the loop — they render the offline state and keep going
- `process.on('SIGINT', ...)`: clear interval, exit 0
- Validates N: `< 0.5 → error "minimum interval is 0.5s"`, `NaN → error`

## Failure modes

| Failure | Behavior |
|---|---|
| Daemon offline (ECONNREFUSED, stale PID) | Offline section above. Exit 1 (default/--quiet); --watch keeps polling. |
| `/v1/status` returns 401 (auth) | `status: auth failed (check config token)` — explicit, not silent. |
| `/v1/status` returns malformed JSON | `status: malformed response from daemon` + truncated raw to stderr. Exit 1. |
| `WATCHDOG_PID_FILE` absent | Watchdog row omitted (silent — desired). |
| Watchdog PID file present, process dead (split-brain) | `watchdog: ⚠ stale PID file (PID=N — process dead)`. Visible warning. |
| `~/.claude/settings.json` missing or unparseable | `hooks: (no settings.json at <path>)` or `hooks: (unparseable)`. Existing behavior preserved. |
| `forumMode: true` but `topics.json` unreadable | `topics: forumMode on, ⚠ topics.json unreadable`. |
| `--watch` daemon transitions mid-loop | Next frame renders new state; loop continues. |
| Concurrent `kuroboto stop` while status fetches | Likely ECONNRESET; treated as offline (same path). |
| `--watch` invalid interval | `error: --watch interval must be ≥ 0.5s`, exit 2. |
| Terminal without ANSI support (legacy cmd.exe pre-Windows-10) | Clear-screen sequence won't render — output will accumulate. Acceptable: target environments (Windows Terminal, PowerShell 7+, Unix terminals) all support ANSI. Documented limitation, not a bug. |
| Network stack out of FDs (rare) | fetch throws; offline path. |

## Audit

No new audit entries. Status is purely a read operation and does not mutate state.

## Test plan

### Unit (`statusFormat.test.ts`)

Helpers:
- `humanizeDuration(0)` → `0s`; `(47000)` → `47s`; `(2_850_000)` → `47m`; `(8_100_000)` → `2h15m`; `(90_000_000)` → `1d1h`.
- `formatCountdown(now+1000)` → `1s`; `(now+90_000_000)` → `1d1h`; `(now-5000)` → `(expirou há 5s)`; `(now-30_000_000)` → `(expirou há 8h20m)`.
- `truncatePath('C:/short')` → `C:/short`; long path → `…/last/segments`.

Formatters (each fed canonical fixtures):
- `formatHumanReadable`: snapshot of fully-populated daemon, snapshot of empty states, snapshot of daemon-offline.
- `formatJson`: snapshot of full payload — schema stability gate.
- `formatQuiet`: alive → `daemon: alive`, code 0. Dead → `daemon: dead`, code 1.

### Integration / anti-regression (`statusCommand.test.ts`)

Each test name carries the bug reference so a future refactor can't quietly regress it.

1. **`'kuroboto status mostra gaming armed (bug confirmado em uso 2026-04-29)'`** — daemon mock returns `gaming: { active: true, until: null }`; assert output contains `gaming: armed (sem timer)`. The literal regression of the reported bug.
2. **`'mode vem do daemon, não do disco (consistência runtime vs state.json)'`** — daemon mock returns `mode: 'away'`; disk has `here`; assert output shows `away`. Closes the latent race in current `status.ts`.
3. **`'inject clients listam após bindSessionByCwd race'`** — register a client, bind a session by cwd, assert output's `inject clients:` block lists the slug + cwd.
4. **`'daemon offline → fallback parcial sem crash'`** — fetch throws ECONNREFUSED; assert output has `daemon: dead`, `mode: here (from disk — daemon offline)`, the trailing `(daemon offline — ...)` note, and exit code 1.
5. **`'WATCHDOG_PID_FILE ausente → linha watchdog não aparece (decoupled from Spec G)'`** — no watchdog file present; assert output has zero `watchdog:` references.
6. **`'--watch tolera daemon caindo mid-loop sem crash'`** — first frame OK, second frame mock returns 503, third frame mock returns OK. Assert 3 frames rendered, no thrown error, loop continued.
7. **`'--json schema snapshot estável'`** — fully-populated fixture → JSON output match snapshot. Test failure forces explicit review of any schema change.
8. **`'forumMode on com topics.json vazio → "0 mapeados" sem crash'`** — TopicManager mock with empty cache; assert `topics: forumMode on, 0 mapeados`.
9. **`'status durante stop concorrente → trata como offline graceful'`** — fetch returns ECONNRESET mid-call; assert same offline path as case 4.

### Manual smoke (post-merge)

1. `kuroboto status` in each state combination: idle / gaming on / 1+ sleeps / forumMode on / inject clients registered. Visually confirm.
2. `kuroboto status --json | jq .gaming.active` — pipe-friendly.
3. `kuroboto status --watch 2` — watch transitions (start a sleep mid-watch, expect frame update; Ctrl+C clean).
4. `kuroboto stop && kuroboto status` — full offline render.
5. `kuroboto status --quiet; echo $?` — exit code on alive vs dead.
6. After Spec G merges, re-run #1 and verify `watchdog: alive (PID=N)` row appears without any code change in this spec.

## Out of scope (follow-ups)

- **Status push notifications** — daemon proactively notifies on state change. Already covered (selectively) by Telegram; full push duplicates that surface.
- **Status history** — `kuroboto status --history` showing last N runs/states. Useful for forensics; not the bug being solved here.
- **Per-machine remote view** — `kuroboto status --remote=mac` for multi-machine setup. Belongs after forumMode v2 + per-host slug prefix work, when the multi-machine substrate is real.
- **Pretty TUI** — full-screen ncurses-style dashboard. `--watch` text repaint covers the live use case at a fraction of complexity.

## Tasks (milestones)

1. **M1**: Add `GET /v1/status` to `routes.ts`. Add `TopicManager.size()`. **Do not** shrink `/v1/health` yet — the CLI still consumes `pending`/`mode`/`gaming` from it via `cli/util.ts`. Add a unit test for the new endpoint shape.
2. **M2**: `statusFormat.ts` (pure) + `statusFormat.test.ts` (helpers + formatter snapshots). Mergeable standalone — no daemon or CLI changes ride on this.
3. **M3**: Refactor `cli/status.ts` consuming M1 + M2. Update `cli/util.ts` (`HealthData` narrows; new `StatusData`; new `fetchStatus`). **Atomically with this CLI change**, shrink `/v1/health` to `{ ok, uptimeSec }` in `routes.ts` — the shrink and its consumer-side update must land in the same PR so no intermediate state breaks the CLI. Add flags. Watch loop. All 9 anti-regression integration tests.

The three milestones are deliberately ordered so each is mergeable on its own without user-facing breakage — M1 only adds; M2 is pure utility; M3 contains the breaking shrink atomically with its consumer update.
