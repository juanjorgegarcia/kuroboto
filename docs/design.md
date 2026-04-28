# Kuroboto — Design Spec

**Status:** Draft (brainstorming complete, awaiting user review)
**Date:** 2026-04-27
**Author:** PoeAltCrafter Dev (`juan.j.garcia007@gmail.com`)
**Codename:** Kuroboto (クロボト) — "kuro" (黒, dark/stealth) + "boto" (Claude-bot, transliterated)

---

## 1. Purpose

Kuroboto is a CLI tool that lets a Claude Code user respond to interactive prompts (permission requests, notifications, free-text questions) from a chat client (Telegram first, others pluggable). It originated as a private Telegram bridge inside the PoeAltCrafter project's `tools/remote/` and was extracted into this standalone, distributable npm package.

**Target audience:** developers using Claude Code who want to step away from the desk and still keep sessions productive — answering "yes/no" prompts and (optionally) free-text questions from their phone.

**Distribution scope:** starts as a small private toolkit shared with a circle of dev friends, but is architected from day one to scale into a public open-source CLI without major refactor.

---

## 2. Goals & non-goals

### Goals
- Bidirectional bridge: Claude Code → chat (notifications, prompts) and chat → Claude Code (decisions, free-text).
- Zero servers operated by the maintainer for the MVP — every user runs their own bot, their own daemon, on their own machine.
- Cross-platform: native Windows + macOS, Linux by extension. No WSL requirement.
- Frictionless install: `npm i -g kuroboto && kuroboto init` walks the user through bot creation and hook setup.
- Never block Claude Code on Kuroboto failure (fail-open by default).

### Non-goals (explicitly out of scope for MVP)
- Hosted/SaaS bot — architecture leaves the door open, but no implementation here.
- Discord/Slack/Signal channels — interface is pluggable, only Telegram ships in v1.
- Group chats / multi-user — one bot, one chat, one user.
- Encrypted message store / audit log — out of scope until product matures.
- iOS/Android native apps — Telegram client is enough.
- Replacing Claude Code's own UI for permissions — Kuroboto is a remote shadow, not a replacement.

---

## 3. Architecture overview

```
+--------------------+        stdin/JSON       +-------------------+
|  Claude Code       | ─────────────────────►  |  kuroboto hook    |
|  (interactive)     | ◄───────────────────── |  (thin CLI subcmd)|
+--------------------+        stdout/JSON      +---------+---------+
                                                         │
                                       HTTP localhost:PORT (loopback only,
                                                          token-auth)
                                                         ▼
+----------------------------------------------------------------+
|  kuroboto daemon (Node process, started by `kuroboto start`)   |
|                                                                |
|   ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐    |
|   │ HTTP server │  │ Pending      │  │ Channel adapter    │    |
|   │ (express)   │  │ requests map │  │ (interface Channel)│    |
|   └─────┬───────┘  └──────┬───────┘  └─────────┬──────────┘    |
|         │                 │                    │               |
|         └─────────────────┼────────────────────┘               |
|                           │                                    |
|                  ┌────────▼─────────┐                          |
|                  │ Telegram poller  │  long-poll loop          |
|                  └────────┬─────────┘                          |
+---------------------------|------------------------------------+
                            │
                  HTTPS api.telegram.org
                            │
                            ▼
                   📱 User's Telegram chat
                            │
                  (optional, layer 3, future)
                            │
                            ▼
                  +------------------+
                  |  tmux send-keys  |  ← Layer 3 free-text path
                  |  (opt-in)        |
                  +------------------+
```

### Key architectural decisions

| Decision | Choice | Rationale |
|---|---|---|
| Stack | Node.js / TypeScript | Claude Code itself is Node; cultural match; `npm i -g` is the lowest-friction install for the audience. |
| Distribution | npm global package | Fastest path; GitHub Releases / single-binary considered as Phase 2. |
| Hook ↔ daemon IPC | HTTP on `127.0.0.1` with token auth | Cross-platform (no Unix socket vs named pipe split); easy to debug; loopback-only is safe. |
| Daemon lifecycle | Manual default (`kuroboto start`); auto-start opt-in (Phase 2) | Beta-testers want visible processes; auto-start is additive. |
| Bot ownership | Each user owns their own bot (BotFather flow in `kuroboto init`) | Privacy-by-default; zero infra for the maintainer; trivial to layer a hosted option later. |
| Channel | Pluggable `Channel` interface, Telegram-only impl in v1 | ~50 LoC of interface today saves a refactor when Discord/Slack arrives. |
| Failure policy | Fail-open by default (configurable) | A flaky bot must never freeze a coding session. |

---

## 4. Components

### 4.1 `cli/` — user-facing commands

| Command | Behavior |
|---|---|
| `kuroboto init` | Interactive wizard. Walks the user through BotFather to create a bot, captures token + chat_id, generates `~/.config/kuroboto/config.json` (mode 0600), merges hook entries non-destructively into `~/.claude/settings.json`. Detects `tmux` and offers Layer 3 opt-in. |
| `kuroboto start` | Spawns daemon foreground (logs streamed to terminal). |
| `kuroboto start --detach` | Daemon in background; writes PID to `~/.config/kuroboto/daemon.pid`. |
| `kuroboto stop` | Reads PID, sends SIGTERM, waits for graceful drain. |
| `kuroboto status` | Prints: daemon alive? channel connected? hooks installed? last activity timestamp? config path? |
| `kuroboto install-service` | **Phase 2.** Generates platform-appropriate auto-start unit (launchd plist on macOS, Scheduled Task on Windows, systemd user unit on Linux). |
| `kuroboto hook <type>` | Subcommand invoked by Claude Code (not the user directly). `<type>` ∈ {`pre-tool`, `notification`, `stop`}. |

### 4.2 `daemon/` — HTTP server + state

**HTTP API** (loopback only, requires `X-Kuroboto-Token` header):
- `POST /v1/permission` — body is the PreToolUse payload; response is `{ decision: "allow" | "deny", reason?: string }`. Long-polled by the hook (timeout matches `policy.permissionTimeoutMs`).
- `POST /v1/notify` — fire-and-forget; immediate ack; daemon dispatches to channel asynchronously.
- `POST /v1/inject` — Phase 2 / Layer 3 only; dispatches text to active `InjectStrategy`.
- `GET /v1/health` — status and counters.

**State**:
- `pending: Map<requestId, { resolve, reject, timeoutHandle, payload, createdAt }>`
- `active: { channelConnected: bool, lastActivityAt, requestsServed }`

**Lifecycle**: SIGTERM → reject new HTTP, drain pending with `{decision: "deny", reason: "shutdown"}`, close channel (with goodbye message), `process.exit(0)`.

### 4.3 `hooks/` — thin handlers

Each subcommand follows the same molde:

1. Read stdin (Claude Code sends JSON).
2. POST to local daemon (timeout per route).
3. If daemon unreachable: behave per `policy.failOpen` (default: emit `{decision: "allow"}` plus stderr warning).
4. Write JSON decision to stdout, `exit 0`.

Hooks **never** maintain state. They are stateless adapters between Claude Code's stdin/stdout protocol and the daemon's HTTP API.

### 4.4 `channels/` — pluggable abstraction

```ts
interface Channel {
  start(): Promise<void>          // begins long-poll / WebSocket / etc.
  stop(): Promise<void>
  sendPrompt(req: PromptRequest): Promise<void>     // outbound: requests a decision
  sendNotification(text: string): Promise<void>     // outbound: fire-and-forget
  on(event: "decision", handler: (d: Decision) => void): void
  on(event: "freeText", handler: (t: string) => void): void  // Layer 3
}

class TelegramChannel implements Channel { /* ... */ }
```

Telegram specifics:
- Decisions are inline keyboard callbacks (`✅ Allow`, `❌ Deny`, `📝 Reply`).
- `callback_data` encodes the requestId so concurrent prompts don't collide.
- Free-text answers come as plain messages; the daemon's state machine routes them based on whether a "Reply"-tagged prompt is awaiting input.

### 4.5 `inject/` — Layer 3 free-text strategies

```ts
interface InjectStrategy {
  available(): boolean
  inject(text: string): Promise<void>
}
class TmuxInjectStrategy { /* tmux send-keys -t <session> "<text>" Enter */ }
// Future: PTYInjectStrategy, ScreenInjectStrategy
```

### 4.6 `config/` — persistence

`~/.config/kuroboto/config.json` (mode 0600):

```json
{
  "channel": { "type": "telegram", "token": "...", "chatId": 123 },
  "daemon": { "port": 47891, "authToken": "<random 32-byte hex>" },
  "inject": { "enabled": false, "strategy": "tmux", "session": "claude" },
  "policy": { "permissionTimeoutMs": 55000, "failOpen": true }
}
```

Wizard generates `daemon.authToken` via `crypto.randomBytes(32).toString("hex")`. Secrets never appear in logs.

### 4.7 `core/` — shared utilities

- Structured JSON logger with rotation (10 MB × 3 files in `~/.config/kuroboto/logs/`)
- TypeScript types matching Claude Code hook payload schemas (kept in sync via `test/fixtures/`)
- Custom error classes (`ConfigError`, `ChannelError`, `DaemonError`)

---

## 5. Data flows

### 5.1 Notification (Layer 1, fire-and-forget)

```
Claude Code ─stdin JSON─► kuroboto hook notification
                                │
                                ▼
                          POST /v1/notify (5s timeout, fail-silent)
                                │
                                ▼
                          daemon.handleNotify(payload)
                                │
                                ▼
                          channel.sendNotification("[Claude] esperando input\n(<folder>)")
                                │
                                ▼
                          📱 Telegram message
```

Hook returns immediately on daemon ack — does not wait for the channel.

### 5.2 Permission request (Layer 2, blocking)

```
1. Claude Code ─JSON─► kuroboto hook pre-tool
       payload = { tool_name: "Bash", tool_input: { command: "git push" }, ... }

2. hook → POST /v1/permission { requestId: <uuid>, payload }
                              ↓ (HTTP keeps alive)

3. daemon:
   - generates requestId
   - pending.set(requestId, { resolve, reject, timeoutHandle: 55s })
   - channel.sendPrompt({
       text: "Pode rodar `git push`?\n\nFolder: PoeAltCrafter",
       buttons: ["✅ Allow", "❌ Deny", "📝 Reply"]
     })

4. 📱 user sees message in Telegram, taps "✅ Allow"

5. Telegram poller receives callback_query → emit("decision", { requestId, allow: true })

6. daemon: pending.get(requestId).resolve({ decision: "allow" })

7. HTTP response → hook → stdout JSON: {"decision": "allow"}

8. Claude Code proceeds with the tool call.
```

**Edge cases:**
- Timeout (no response in 55s) → resolve with `{decision: "deny", reason: "timeout"}` + Telegram "⏱️ tempo esgotado, neguei pra você"
- "📝 Reply" tapped → bot prompts for free-text. Keyword routing: "ok"/"sim"/"yes" → allow; otherwise deny. Free-text reason carried back as `reason`.
- Daemon dies mid-wait → hook detects TCP RST → fail-open per policy.

### 5.3 Free-text injection (Layer 3, opt-in, requires tmux)

```
1. Notification hook fires (Layer 1) — Telegram receives "[Claude] esperando input"

2. User in Telegram types: "validateUserInput"

3. Telegram poller receives message → emit("freeText", "validateUserInput")

4. daemon: if (config.inject.enabled && !pendingReply) → injectStrategy.inject(text)
                                                ↓
                                         tmux send-keys -t <session> "validateUserInput" Enter

5. Claude Code receives the input on stdin and proceeds.
```

**Routing rule**: free-text only triggers injection when no permission request is pending an explicit "Reply". When a "Reply" is open, free-text is consumed as the reply payload.

### 5.4 Daemon startup

```
1. user runs `kuroboto start`
2. daemon loads config → validates token → checks port free
3. daemon binds HTTP on 127.0.0.1:<port> (auth token required)
4. daemon spawns channel.start() → TelegramChannel begins long-poll
5. status: ✅ ready
```

### 5.5 Graceful shutdown (SIGTERM)

```
1. SIGTERM received
2. stop accepting new HTTP requests (close server, drain in-flight)
3. for each pending entry: resolve with { decision: "deny", reason: "daemon shutdown" }
4. channel.stop() → cancels long-poll, sends "🔻 daemon offline" to Telegram
5. exit 0
```

---

## 6. Error handling & failure modes

### Principle: never block Claude Code

A flaky bot must not freeze a coding session. Default policy is fail-open (`{decision: "allow"}`) with a stderr warning. Users who want fail-closed can flip `policy.failOpen: false`, but the default protects shared sanity.

### Failure matrix

| Scenario | Hook behavior | User experience |
|---|---|---|
| Daemon not running | fail-open + stderr warning | Tool call proceeds; warning visible in terminal |
| Daemon alive but config drifted (wrong port) | fail-open + stderr | Same; `kuroboto status` surfaces the mismatch |
| Telegram API down | daemon returns `{decision: "allow", reason: "channel unavailable"}` after 5s | Tool call proceeds; daemon log records the outage |
| Telegram bot token revoked | fail-open + OS-level notification ("Kuroboto: bot token inválido, run `kuroboto init`") | Local desktop notification; `kuroboto status` flags it |
| User does not respond in 55s | daemon resolves with deny + Telegram "⏱️ tempo esgotado" | Bot explains; user may rerun the action to re-prompt |
| User replies "asdf" to a "Reply" request | daemon treats as deny + replies "❌ resposta não compreendida, neguei" | User sees the rejection |
| Daemon crash mid-pending | hook detects TCP close → fail-open | Equivalent to "daemon offline" |
| Multiple Claude Code sessions concurrent | pending map keyed by requestId; daemon multiplexes | Telegram messages include folder identifier; user can answer in any order |
| Hook invoked before `kuroboto init` | fail-open + stderr "kuroboto não configurado, run `kuroboto init`" | Claude Code proceeds; message visible |
| Long-poll Telegram timeout (transient) | poller retries with backoff (1s, 2s, 5s, 30s max) | Transparent |
| User installs but forgets `start` | fail-open. `kuroboto status` shows "daemon parado". Phase 2: shell startup hint. | — |

### Logging

- Daemon: `~/.config/kuroboto/logs/daemon.log` (JSON lines, rotated 10 MB × 3).
- Hooks: stderr only (lifetime ~80 ms — no file).
- **Never logged**: token, chat_id, full `tool_input` (may contain secrets — log only `tool_name` and a SHA-256 hash of the input).

### Concurrency

- **Daemon-start race**: second invocation detects PID file + port → exits with "daemon already running, PID=X".
- **Hook race**: each invocation gets a unique requestId; daemon handles in parallel; Telegram callback_data carries the requestId so taps can't cross-resolve.
- **Stale pending cleanup**: 10 s tick removes timed-out entries with deny+timeout reason.

### Security

- HTTP server binds **only** on `127.0.0.1`.
- Auth token required on every request; missing/wrong → 401.
- Token generated with `crypto.randomBytes(32)`; persisted at mode 0600.
- Telegram poller filters updates by `chatId`; foreign messages are dropped.
- Callback queries additionally validate `from.id`.

---

## 7. Testing strategy

The maintainer's working philosophy is "manual first, formalize later." Tests focus on critical paths and security boundaries — not exhaustive coverage.

### Test layers

| Layer | Tool | Scope | Trigger |
|---|---|---|---|
| Unit | `vitest` | Pure logic: payload parser, decision-by-keyword, timeout cleanup, channel adapter (Telegram mocked) | Every PR |
| Integration | `vitest` + `supertest` | Daemon HTTP routes: permission flow, notify, auth, fail-open paths | Every PR |
| Channel contract | `vitest` + Telegram fixtures | The `Channel` interface contract — every implementation must pass the same suite | Every PR |
| End-to-end | shell + dedicated BotFather sandbox bot | Real daemon + real bot + synthetic hook payload → confirm round-trip | Pre-release |
| Manual smoke | Maintainer | Layer 3 (tmux), `install-service`, OS-specific quirks | Before each release cut |

### Critical paths (mandatory tests before merge)

1. Permission flow happy path: allow, deny, timeout
2. Fail-open when daemon offline
3. Auth token rejection (missing → 401)
4. Loopback-only bind (assert no response on external IP)
5. `chatId` filter on the poller
6. Pending request cleanup
7. Concurrent requests across multiple Claude Code sessions

### Not tested (assumed)

- Telegram API behavior (mocked in unit/integration; e2e covers)
- `tmux send-keys` (manual smoke; tmux is stable)
- `npm pack` + global install (CI runs once)

### CI matrix

GitHub Actions, `[ubuntu-latest, macos-latest, windows-latest]` × `[node-20, node-22]`. E2E runs only on `ubuntu-latest` (Telegram secrets in GitHub Secrets). README badge.

### Fixtures

`test/fixtures/hooks/` holds real Claude Code payloads: `preToolUse-bash.json`, `preToolUse-edit.json`, `notification.json`, `stop.json`. Refresh when Claude Code's hook schema evolves.

---

## 8. Repo layout (proposed)

```
kuroboto/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE                         (MIT)
├── src/
│   ├── cli/
│   │   ├── index.ts                (commander entry)
│   │   ├── init.ts
│   │   ├── start.ts
│   │   ├── stop.ts
│   │   ├── status.ts
│   │   └── installService.ts       (Phase 2)
│   ├── daemon/
│   │   ├── server.ts               (express setup)
│   │   ├── routes.ts
│   │   ├── pending.ts              (request map + timeout)
│   │   └── lifecycle.ts            (startup/shutdown)
│   ├── hooks/
│   │   ├── preTool.ts
│   │   ├── notification.ts
│   │   └── stop.ts
│   ├── channels/
│   │   ├── Channel.ts              (interface)
│   │   └── telegram/
│   │       ├── TelegramChannel.ts
│   │       └── poller.ts
│   ├── inject/
│   │   ├── InjectStrategy.ts       (interface)
│   │   └── tmux.ts
│   ├── config/
│   │   ├── load.ts
│   │   ├── save.ts
│   │   └── schema.ts
│   └── core/
│       ├── logger.ts
│       ├── types.ts
│       └── errors.ts
├── test/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
└── .github/workflows/ci.yml
```

The repo is targeted at `github.com/<user>/kuroboto`. Initial visibility: private — flipped to public when the maintainer is comfortable.

---

## 9. Roadmap

### MVP (v0.1) — what this spec scopes

- Layers 1 + 2 fully functional (notification + permission).
- Telegram channel.
- `kuroboto init` / `start` / `stop` / `status`.
- Manual daemon start.
- Cross-platform (Win + Mac primary; Linux works).
- Critical-path tests + CI matrix.

### v0.2 — quality of life

- `kuroboto install-service` with native auto-start units.
- Layer 3 (tmux injection), opt-in.
- `kuroboto status` ergonomics: shell startup hint when daemon is dead.
- Better message formatting in Telegram (markdown, code blocks for commands).

### v1.0 — public-ready

- Discord channel adapter.
- Documentation site (`kuroboto.dev`).
- Public GitHub repo, npm publish.
- Show HN / community announce.

### Phase 2+ — exploration

- Hosted bot option (`kuroboto init --hosted`).
- PTY-based injection (drops the tmux dependency for Layer 3).
- Single-binary distribution via `bun build` or equivalent.
- Slack, Signal channels.

---

## 10. Open questions

None blocking. To be revisited during implementation:
- Exact UX for the `📝 Reply` flow when free-text is "almost yes" (e.g., "sure, do it" — keyword router robustness).
- Whether to bundle a TUI (`kuroboto watch`) for live debugging, or rely on `tail -f` of the JSON log.
- Whether the wizard should generate the bot via Telegram API (passing the user through a guided BotFather chat is fine for v1).

---

## 11. References

- Origin protótipo: `tools/remote/notify-hook.ps1` and `tools/remote/telegram_bridge.py` in the PoeAltCrafter repo (since deleted post-extraction).
- Claude Code hooks docs: <https://docs.claude.com/en/docs/claude-code/hooks>
- Telegram Bot API: <https://core.telegram.org/bots/api>

---

## 12. v0.2 redesign — Smart delay + presence mode (added 2026-04-27 after v0.1 dogfood)

### Why this section exists

The v0.1 dogfood revealed two architectural mistakes in §5 above:

1. **Hook output schema was wrong.** PreToolUse must return `{hookSpecificOutput: {hookEventName, permissionDecision, permissionDecisionReason}}` — not the bare `{decision: ...}` documented in earlier sections. Earlier text reflected the daemon's internal format, not Claude Code's wire contract.
2. **Layer 2 was unusable when wired to *every* tool call.** A `matcher: ""` hook intercepts every Read/Edit/Bash, which destroys local UX even when the user is at the desk and just wants Claude Code's normal permission UI.

This section rewrites Layer 2 to be ergonomic for the dual context (at-desk vs. afk) and replaces §5.2.

### 12.1 Presence mode

The daemon owns a single piece of mutable state: `mode ∈ {"here", "away"}`, persisted to `~/.config/kuroboto/state.json` (mode 0600). Default is `here`.

| Mode | PreToolUse behavior | Notification behavior |
|---|---|---|
| `here` (default) | Hook returns `permissionDecision: "ask"` immediately — Claude Code shows its native UI | Hook arms a pending entry on the daemon. Daemon waits `policy.notifyDelayMs` (default 60s). Heartbeat cancels. Otherwise → push to Telegram (one-way: "Claude is waiting in *project*"). |
| `away` | Hook **blocks**, daemon sends Telegram inline keyboard, hook returns the decision the user taps | Hook arms pending; `policy.notifyDelayMs` ignored (push immediately). |

Toggled via `kuroboto here` / `kuroboto away` (which `PUT /v1/mode`). Status surfaces the active mode.

### 12.2 Smart delay (heartbeat cancellation)

The daemon maintains `pendingNotifications: Map<requestId, {timer, payload, createdAt}>`. The flow:

1. `Notification` hook → `POST /v1/notify` with payload → daemon creates pending, schedules `setTimeout(notifyDelayMs)` to fire push.
2. Any heartbeat hook (`PostToolUse`, `UserPromptSubmit`, `Stop`) → `POST /v1/heartbeat` → daemon clears all pending notifications (user is back at the desk).
3. If the timer fires first, push lands in Telegram and that pending entry is removed.

Only **UserPromptSubmit** is a real heartbeat — that hook fires when the user actually submits a new prompt:

```json
"UserPromptSubmit":[{"matcher": "", "hooks": [{"type": "command", "command": "kuroboto hook user-prompt-submit"}]}]
```

`PostToolUse` and `Stop` are still registered (so future logic can use them) but are **silent no-ops** in the MVP — neither contacts the daemon. Earlier drafts treated these as heartbeats too, but live debugging showed:

- `PostToolUse` fires on every Claude tool call → cancels every pending notification within milliseconds (Claude's own activity gets read as the user's).
- `Stop` fires whenever Claude finishes a turn → races against a Notification that armed during the same turn and silences the smart-delay push.

Treating only `UserPromptSubmit` as a heartbeat keeps the contract clean: a heartbeat means *the user submitted a new message*, not *Claude did something*.

### 12.3 Hook output contract (correct schema)

`PreToolUse` writes to stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "<short reason>"
  }
}
```

Other hooks (Notification, PostToolUse, UserPromptSubmit, Stop) write nothing to stdout — they're pure signals.

### 12.4 Permission flow in `away` mode

Replaces §5.2 when mode is `away`:

```
1. PreToolUse hook → POST /v1/permission { requestId, payload }
2. daemon checks matcher: payload.tool_name ∈ policy.permissionMatchers ∧ mode === "away"
   - if no match: respond {decision: "ask"} → hook returns ask → Claude UI shows
   - if match: continue
3. daemon channel.sendPrompt(...) — Telegram inline keyboard
4. user taps Allow/Deny → daemon resolves pending → HTTP response
5. hook converts {decision: "allow"} → {hookSpecificOutput: {permissionDecision: "allow", ...}} and writes stdout
```

Timeout, fail-open, and concurrency rules of §6 still apply.

### 12.5 Config additions

```json
{
  "policy": {
    "notifyDelayMs": 60000,
    "permissionTimeoutMs": 55000,
    "permissionMatchers": ["Bash", "Edit", "Write"],
    "failOpen": true
  }
}
```

`state.json` (separate from `config.json` so wizard re-runs don't reset it):

```json
{ "mode": "here" }
```

### 12.6 Migration from v0.1

`kuroboto init` writes `state.json` with `mode: "here"` and updates the hook installer in `~/.claude/settings.json` to register **all five** hooks (Notification, PreToolUse, PostToolUse, UserPromptSubmit, Stop). Existing v0.1 installs upgrade by re-running `kuroboto init` (idempotent merge).
