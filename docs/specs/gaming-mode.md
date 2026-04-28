# Gaming Mode

> Status: implementing in `feat/gaming-mode`

## Problem

In `away` mode, every `Bash` / `Edit` / `Write` from Claude Code becomes a Telegram prompt
with 4 buttons. Fine for normal work, painful when the dev wants to step away (gaming,
sleeping) and just let Claude finish a sequence of tasks autonomously.

## Solution

A toggleable "gaming" state on the daemon. While active, every PreToolUse hook
short-circuits to `allow` without going through Telegram, **except** for tool names
listed in `policy.gamingAlwaysAsk` (default empty — full carta-branca).

Each auto-allow still:
- emits an FYI Telegram notification (no buttons) so the dev can monitor in real time
- writes to the audit log with `source: 'gaming'`

State lives in memory only. Daemon restart resets it. Optional auto-off timer
(`gaming on 15m`) prevents accidental "left it on forever".

## Public API

### CLI
```
kuroboto gaming on              # on, no timer (off only via `gaming off`)
kuroboto gaming on 15m          # on for 15 minutes, then auto-off
kuroboto gaming on 2h           # on for 2 hours
kuroboto gaming off             # off
kuroboto gaming status          # "on (restam 12m)" or "off"
```

Duration grammar: `<integer><s|m|h>`. `0s` rejected. Invalid → CLI error before HTTP.

### HTTP (loopback only, X-Kuroboto-Token required)
```
GET  /v1/gaming         → { active: boolean, until: number | null }
PUT  /v1/gaming         body: { on: true, durationMs?: number } | { on: false }
                        → { ok: true, active, until }
```

`until` is the absolute expiry timestamp in ms (epoch). `null` = no timer.

### Config
```jsonc
{
  "policy": {
    "gamingAlwaysAsk": []   // tool names to keep prompting in Telegram even when gaming is on
  }
}
```

## Behavior

### `/v1/permission` decision tree
```
if gaming.active && !gamingAlwaysAsk.includes(tool_name):
    audit(source='gaming')
    notify FYI to Telegram (no buttons)
    return { decision: 'allow', reason: 'gaming' }
else:
    fallthrough to existing flow (here mode, away mode, away+matched, etc.)
```

### Timer
- `armGaming(durationMs)` clears any prior timer, sets `until = Date.now() + durationMs`
  and a `setTimeout` that flips `active = false` on fire.
- `armGaming(undefined)` sets `active = true, until = null`, no timer.
- `cancelGaming()` clears timer and sets `active = false, until = null`.
- Daemon shutdown clears timer (no GC leak).

### Status semantics
- `active = false`, `until = null` → "off"
- `active = true`, `until = null` → "on (no timer)"
- `active = true`, `until = X` → "on (restam ~Nm/Ns)" — computed at status-call time
- If `until <= Date.now()` and somehow still active, treat as off (defensive)

## Invariants

- `until !== null` implies `active === true` while not yet expired
- Auto-off transition is idempotent (firing twice is a no-op)
- `gamingAlwaysAsk` is read fresh from config on each request (no caching) — config
  edits + daemon restart take effect on next request

## Out of scope (follow-ups)

- Persistence across daemon restart (intentional: restart resets to off; matches
  philosophy that "gaming is a deliberate, time-bounded act")
- Per-project gaming (one global toggle for now)
- Daemon-side allowlist match (the unrelated PR D — daemon reads
  `.claude/settings.local.json` to skip Telegram for already-trusted patterns)

## Test plan

**Unit (`gaming.test.ts`):**
- `parseDuration` correctly parses `15s`, `30m`, `2h`; rejects `0`, `15`, `15x`, negative
- `armGaming(undefined)` sets active without timer
- `armGaming(50ms)` flips off after timeout
- `armGaming(big)` then `cancelGaming()` clears timer (no off after big delay)
- `armGaming(50ms)` then `armGaming(100ms)` — first timer canceled, second wins

**Integration (`daemon.test.ts`):**
- `PUT /v1/gaming { on: true }` → `/v1/permission` returns instant `allow` for Bash
- `PUT /v1/gaming { on: true, durationMs: 50 }` → wait 100ms → `/v1/permission` returns
  the normal flow (here-mode `ask`) again
- `gamingAlwaysAsk: ['Bash']` + gaming on → `/v1/permission` for Bash falls through
  to the normal away flow (sends prompt to Telegram); for Edit returns instant allow
- `GET /v1/gaming` reflects current state

**Smoke:**
- `kuroboto gaming on 30s` → `kuroboto gaming status` shows ~30s remaining → wait → off
- Real Claude session in away mode + `gaming on` → Bash runs, FYI lands in Telegram, no buttons
