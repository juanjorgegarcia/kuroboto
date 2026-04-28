# Kuroboto

Bridge Claude Code permission prompts to your phone via Telegram. Decide from
the couch, the bus, or while gaming. Plus two autonomous modes for when you
don't want to think at all.

**Status:** v0.2 in active development. License: MIT.

## What it does

Claude Code asks for permission before running `Bash` / `Edit` / `Write`. Instead
of forcing you to be at the terminal, kuroboto:

- Forwards the prompt to your private Telegram bot with inline buttons
- Stores your decisions in an auditable JSONL log
- Can flip the whole flow off and let Claude run autonomously while you're away
- Can spawn an isolated worktree, run Claude headless against a plan, and open
  a PR for you to review when it's done

## Architecture

```
┌─────────────────┐         ┌───────────────────────┐
│ Claude Code     │  hook   │  kuroboto daemon      │   HTTPS    ┌───────────┐
│ (PreToolUse,    ├────────►│  (Express loopback,   │◄──────────►│ Telegram  │
│  Notification,  │  POST   │   X-Kuroboto-Token,   │  long-poll │ Bot API   │
│  Stop hooks)    │         │   in-memory state)    │            └───────────┘
└─────────────────┘         └───────────────────────┘                 ▲
                                                                       │
                            Filesystem state:                         │ you, on
                              ~/.config/kuroboto/config.json          │ phone
                              ~/.config/kuroboto/audit.jsonl          ▼
                              ~/.config/kuroboto/state.json     ┌───────────────┐
                              ~/.config/kuroboto/logs/          │  Buttons /    │
                              <project>/.claude/settings.local  │  text replies │
                              ~/.kuroboto/worktrees/<slug>/     └───────────────┘
```

The daemon binds to loopback only and requires a 64-char auth token. Each user
runs their own bot — no shared infrastructure, no secrets in logs.

## Quickstart

```bash
npm install
npm run build
npm link                       # exposes `kuroboto` globally

kuroboto init                  # wizard: Telegram bot setup + hooks
kuroboto start --detach        # daemon in background
kuroboto claude                # opens Claude Code with hooks active
```

## The four states

Two persistent modes (`here` / `away`) plus two transient overrides (`gaming`,
`sleeping`). The transient ones live only in daemon memory — restart resets
them, by design.

| State | Enter via | Permission goes to | FYI notification | Persists across restart? |
|---|---|---|---|---|
| **here** (default) | `kuroboto here` | Claude Code's terminal UI | delayed (default 60s, cancelled if you reply locally) | yes |
| **away** | `kuroboto away` | Telegram (4 buttons) | immediate | yes |
| **gaming** | `kuroboto gaming on [15m]` | auto-allow (except `gamingAlwaysAsk` tools) | immediate, no buttons (FYI only) | no |
| **sleeping** | `kuroboto sleeping start --prompt …` | full carta-branca + headless Claude in a worktree | start, done, and failure events | no |

Resolution order in `/v1/permission`:

```
gaming.active  &&  tool ∉ gamingAlwaysAsk    → allow immediately
mode === 'here'  ||  tool ∉ permissionMatchers → ask (Claude UI handles it)
mode === 'away'  &&  tool matched              → Telegram prompt with 4 buttons
```

### `here` — you're at the keyboard

Daemon returns `ask`; Claude shows its normal terminal permission UI.
Notifications are delayed by `policy.notifyDelayMs` (default 60s) — if you
respond at the terminal first, the `Stop` hook cancels the pending push so your
phone stays quiet.

### `away` — you're on the phone

Permission prompts arrive in Telegram with four buttons:

- **✅ Allow** — once
- **🔓 Allow & remember** — allow + persists a matcher to
  `<cwd>/.claude/settings.local.json` (so future sessions skip the prompt)
- **❌ Deny** — block
- **💬 Deny with note** — block, prompt edits to "✏️ aguardando justificativa…",
  the next text message you send becomes the `permissionDecisionReason` Claude
  receives

`policy.rememberGranularity` controls the matcher precision:

- `tight` (default) → `Bash(npm install:*)` — first 2 tokens
- `permissive` → `Bash(npm:*)` — first token only

Permission timeout is `policy.permissionTimeoutMs` (default 55s); on timeout
the request is denied with `reason: 'timeout'`.

### `gaming` — distracted, not gone

`kuroboto gaming on [duration]` arms an in-memory flag. While active, every
`/v1/permission` call short-circuits to `allow` without going through Telegram.

You still get an FYI notification per tool call (`🎮 [proj] Bash: npm test`)
without buttons — so you can monitor between rounds and `gaming off` if you see
something destructive.

`policy.gamingAlwaysAsk: ['Bash']` makes specific tools fall back to the normal
prompt flow. Default is `[]` (full carta-branca).

Optional auto-off timer: `kuroboto gaming on 15m` flips back to off after 15
minutes. Prior gaming snapshot (including any remaining timer) is preserved
across nested sleep sessions.

### `sleeping` — fully autonomous

```bash
kuroboto sleeping start --prompt "implement feature X"
kuroboto sleeping start --plan ./plan.md
```

Daemon state machine:

```
1. createWorktree   → ~/.kuroboto/worktrees/<slug>/, branch sleep/<slug>-<random6>
2. snapshot gaming  → arm gaming so Claude doesn't block on prompts
3. spawn claude -p <prompt>   (cwd = worktree)
4. monitor:
   - exit 0       → finishSleep: git push + gh repo view (default branch)
                                 + gh pr create + notify "✅ done — PR: <url>"
   - exit ≠ 0     → notify "❌ failed — exit N"
   - max 2h       → kill child + notify "⏰ timeout"
   - DELETE API   → kill + notify "🛑 cancelled"
5. restore gaming → flip back to snapshot (preserving any remaining timer)
```

Invariants:

- **One sleep at a time** (`POST` returns 409 if one is already active)
- **Worktree is never auto-deleted** — you inspect / remove manually
- **Daemon restart cancels** active sessions (state is in-memory only)
- **Gaming stays armed during `git push`/`gh pr create`** (restore happens
  after `await onSuccess` resolves)

## Filesystem state

| Path | Contents | Manual edit? |
|---|---|---|
| `~/.config/kuroboto/config.json` | bot token, port, authToken (64 chars), policy | yes — restart to apply |
| `~/.config/kuroboto/state.json` | `{ mode: 'here' \| 'away' }` | yes — restart to apply |
| `~/.config/kuroboto/audit.jsonl` | append-only JSONL: every permission decision | read with `jq` or `kuroboto audit list/export` |
| `~/.config/kuroboto/logs/daemon.log` | structured JSONL daemon events | read for debugging |
| `<project>/.claude/settings.local.json` | matchers persisted by 🔓 Allow & remember | yes, or via `kuroboto allowlist list/export` |
| `~/.kuroboto/worktrees/<slug>/` | sleep-mode worktrees (kept after success/fail/cancel) | inspect / remove manually |

## CLI surface

```
kuroboto init                                 # bootstrap (token, hooks, config)
kuroboto start [-d|--detach]                  # start daemon
kuroboto stop                                 # SIGTERM + drain pending
kuroboto status                               # diagnose
kuroboto here / away                          # toggle persistent mode

kuroboto claude [args]                        # ensures daemon up + spawns claude
kuroboto ohayo                                # tmux session "claude" + daemon
kuroboto hook <type>                          # internal, do not call directly

kuroboto allowlist list|export [dir]          # inspect .claude/settings.local.json
kuroboto audit list|export [--since 5m --cwd P --limit N]

kuroboto gaming on [duration] | off | status
kuroboto sleeping start --prompt|--plan [--repo P --max 2h] | cancel | status
```

## HTTP API (loopback only, X-Kuroboto-Token header)

```
GET  /v1/health           → { ok, uptime, pending, mode, gaming }
GET/PUT /v1/mode          → { mode: 'here'|'away' }
GET/PUT /v1/gaming        → { active, until }
GET/POST/DELETE /v1/sleeping → snapshot + start/cancel
POST /v1/heartbeat        → cancel pending notifications
POST /v1/notify           → schedule/send a notification
POST /v1/permission       → decide (returns { decision, reason?, remember? })
```

## Why these design choices

- **Daemon, not direct Telegram from hooks** — hooks live ~1s; Telegram needs
  long-poll. Daemon is the single persistent process that aggregates and serializes.
- **In-memory transient state** for gaming/sleeping — restart = reset. Avoids
  "I left gaming on and went to bed = autonomous mode forever" footgun.
- **Worktree never auto-deleted** — destructive cleanup on bug or in-progress
  work is worse than leaving an inspectable directory behind.
- **Audit JSONL append-only** — auditable with any tool (`jq`, `grep`),
  free-software spirit. CLI commands are convenience, not gatekeepers.
- **Hook is fail-open** — if daemon is down, Claude falls back to its normal
  terminal permission UI; the session never freezes.
- **Loopback + auth token** — your machine, your daemon, no external attack
  surface.

## Known limitations

- `awaitingNoteFor` (deny-with-note state) is a single slot — two simultaneous
  deny-with-note clicks collide; the first request waits for `permissionTimeoutMs`
  and ends with `reason: 'timeout'`.
- Daemon does **not** check `<cwd>/.claude/settings.local.json` before prompting
  via Telegram, so the matchers persisted by Allow & remember don't take effect
  until you restart the Claude session. (Tracked as a follow-up.)
- `kuroboto ohayo` is currently broken (`[server exited unexpectedly]`).
- Default `policy.notifyDelayMs` is 60s — recommend lowering to 15s for the
  intended UX.
- Sleep mode does not yet write `.kuroboto-sleep.log` (the headless Claude's
  stdout/stderr is not redirected to disk).
- `cancel()` has a 5s exit-event timeout; a Claude child stuck in slow network
  I/O could be left orphaned and a follow-up `start()` could race with it.
- No native autostart on Windows boot — schedule a Task manually for now.

## Spec docs

- [docs/specs/gaming-mode.md](docs/specs/gaming-mode.md)
- [docs/specs/sleep-mode.md](docs/specs/sleep-mode.md)
- [docs/design.md](docs/design.md) — original v0.2 architecture
