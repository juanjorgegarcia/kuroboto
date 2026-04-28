# PTY-based injection (replaces tmux send-keys)

> Status: planned. Spec E. Bumped ahead of Spec D (parallel sleeps) because Q&A is the load-bearing feature for the "user away from desk" use case and the current tmux dependency forces an unacceptable UX cost.

## Problem

Spec B shipped free-text Q&A by sending the user's reply to `tmux send-keys -t <session>`. This works but forces a hard requirement: claude has to run inside a tmux session. The cost shows up in everyday use:

- **Tmux status bar always visible** at the bottom of the terminal — the user finds it ugly when coding at the desk
- **Bell / window-status escape sequences are intercepted by tmux** — Windows Terminal's tab notification icon stops working, so the visual "claude finished" signal disappears even when the user isn't away
- **tmux is a hard dep** — has to be installed (a pain on Windows) and the daemon refuses to start if `inject.enabled=true` but tmux is missing
- **Daemon spawns no PTY itself** — there's no path to inject without an external multiplexer

The user can't realistically opt out: free-text Q&A is the feature that makes "leave claude running, walk away" actually viable. Without it, claude stops at the first non-button question and the session is dead until the user walks back.

The fix is to drop tmux entirely (as the default) and have kuroboto wrap claude in a PTY itself. The wrapper is the new `kuroboto claude` invocation: spawns claude via `node-pty`, multiplexes the user's terminal IO with claude's PTY, and exposes a local HTTP endpoint for the daemon to inject text into the PTY when a Q&A reply arrives.

The native terminal stays clean. Tab status icons work. No tmux. Q&A still works.

## Solution

```
+----------------------+         +----------------------+
|  user's terminal     |  <----  |  kuroboto claude     |
|  (Windows Terminal,  |  ---->  |  (CLI process)       |
|   iTerm, etc.)       |         |  - owns PTY          |
+----------------------+         |  - HTTP /inject      |
                                 +----------+-----------+
                                            | spawn via node-pty
                                            v
                                    +---------------+
                                    |  claude       |
                                    |  (child)      |
                                    +---------------+

  CLI process
     |
     | HTTP loopback (local-only) for register/inject
     v
  daemon (existing)
     - clients: Map<slug, ClientInfo>
     - sessionToSlug: Map<session_id, slug>  (late-binded)
```

**Default behavior change:** `kuroboto claude` (no flag) now spawns claude inside a PTY owned by the CLI process. The user's terminal sees claude exactly as if it were running natively — no multiplexer in their face.

**Tmux preserved as opt-in:** `kuroboto claude --tmux` falls back to the existing flow (claude in a tmux session, daemon uses `tmux send-keys`). For users who already have a tmux setup or want the legacy path.

**`claude` binary direct (no kuroboto):** still works — no PTY, no inject. The same as today.

## Architecture

### CLI side (`src/cli/injectClient.ts`, new)

- Spawns claude via `node-pty` with the parent terminal's `cols`/`rows` and `TERM`
- Sets the user's stdin to raw mode while claude runs; restores on exit
- Multiplexes:
  - user `stdin` → PTY input (forwarded byte-stream)
  - PTY output → user `stdout`
  - `SIGWINCH` (Unix) / Windows resize event → `pty.resize(cols, rows)`
- Listens on a free local port (`http.createServer().listen(0, '127.0.0.1')`)
- Exposes single endpoint `POST /inject` accepting `{ text: string }`. Body is written to the PTY input. Response: `{ ok: true }`.
- On startup:
  - Loads `~/.config/kuroboto/daemon.pid.json` (sentinel) to find daemon port
  - POSTs `/v1/inject-clients` with `{ slug, pid, cwd, localPort }`
  - If daemon offline / sentinel missing: start anyway, `fs.watch()` the sentinel; re-register when it appears or changes
- On clean exit: `DELETE /v1/inject-clients/<slug>` (best-effort)
- On claude exit: print `claude exited (code N)`, deregister, exit with same code

### Daemon side (`src/daemon/injectClients.ts`, new)

In-memory state:
- `clients: Map<slug, { pid, cwd, localPort, registeredAt }>` — CLI processes that have registered
- `sessionToSlug: Map<session_id, slug>` — late-binded when a hook with that `session_id` arrives at a `cwd` matching a registered client

New endpoints (`src/daemon/routes.ts`):

| Method | Path | Body | Behavior |
|---|---|---|---|
| `POST` | `/v1/inject-clients` | `{ slug, pid, cwd, localPort }` | Adds to `clients` map. Slug must be unique — returns 409 with current owner info if collision. Auth via existing `X-Kuroboto-Token`. |
| `DELETE` | `/v1/inject-clients/:slug` | — | Removes from `clients` and any `sessionToSlug` entries pointing at it. |
| `GET` | `/v1/inject-clients` | — | Returns `[{ slug, pid, cwd, localPort, sessions: [session_id...] }]` for `kuroboto status` UI |

Late-binding: in the existing PreToolUse / Notification handlers, after extracting `session_id` and `cwd`, daemon checks `clients` for any entry with the same `cwd`; if found and `sessionToSlug` doesn't already have `session_id`, sets `sessionToSlug[session_id] = slug`.

Q&A inject routing (replaces the current tmux call in `src/inject/tmux.ts`):

```ts
// when a Telegram reply resolves a pendingReply:
const slug = ctx.sessionToSlug.get(pendingReply.sessionId);
if (!slug) {
  // unknown session — fallback to Telegram message with text
  return { ok: false, reason: 'no client registered for this session' };
}
const client = ctx.clients.get(slug);
if (!client) {
  // stale binding — clear and fallback
  ctx.sessionToSlug.delete(pendingReply.sessionId);
  return { ok: false, reason: 'client gone' };
}
const res = await fetch(`http://127.0.0.1:${client.localPort}/inject`, {
  method: 'POST',
  body: JSON.stringify({ text: replyText }),
  signal: AbortSignal.timeout(5000),
});
if (!res.ok) {
  // CLI unreachable — drop registration, fallback to user
  ctx.clients.delete(slug);
  ctx.sessionToSlug.delete(pendingReply.sessionId);
  return { ok: false, reason: 'inject POST failed' };
}
```

Fallback (when inject route fails) reuses Spec B's existing fallback: `❌ inject falhou: ${reason}\n\nSua reply foi:\n${text}` to Telegram, audit `qa-inject-failed`.

### Daemon-pid sentinel (`src/daemon/server.ts`, modify)

On startup:
- Write `~/.config/kuroboto/daemon.pid.json` with `{ pid, port, startedAt: <iso8601> }`
- File mode 0600

On shutdown (SIGTERM/SIGINT graceful path):
- Delete the sentinel (best-effort; if daemon crashes it stays stale, which is fine — CLI's `fs.watch` only triggers on changes)

CLI uses `fs.watch()` on this file; on `change` events, re-registers itself with the daemon. This is the event-driven daemon-restart-recovery the user requested (no polling).

### Slug generation

Default: `<basename(cwd)>` + `-<6-char random>` if collision. Same shape as sleep mode's slugs.

Override: `kuroboto claude --name fix-bot-ux` (explicit slug, must be unique).

If user-provided slug collides on registration, daemon returns 409. CLI prints the conflict and exits with non-zero (user can retry with a different name or kill the conflicting process).

## Files

**Create:**
- `src/inject/pty.ts` — pure helper: `injectViaPty(client: ClientInfo, text: string): Promise<void>`. Wraps the `fetch` + error mapping above.
- `src/cli/injectClient.ts` — CLI-side wrapper: spawn claude, multiplex IO, expose local HTTP endpoint, register/deregister with daemon, fs-watch sentinel.
- `src/daemon/injectClients.ts` — daemon-side state: `Clients` class with `register`, `deregister`, `lookupBySession`, `bindSessionToSlug`. In-memory, stateless across daemon restarts (CLIs auto-re-register via sentinel).
- `test/unit/injectClients.test.ts` — registration + late-binding + lookup edge cases.
- `test/unit/injectPty.test.ts` — pty inject helper with mocked fetch.
- `test/unit/injectClient.test.ts` — CLI-side: mock node-pty, mock daemon, verify register-on-startup, deregister-on-exit, sentinel re-register.

**Modify:**
- `src/cli/claude.ts` — replace the existing `exec claude` path with `injectClient.run(opts)` by default. Add `--tmux` flag that bypasses PTY and uses the legacy tmux flow (existing code path; no behavior change in tmux mode).
- `src/cli/index.ts` — register `--tmux` and `--name <slug>` flags on the `claude` subcommand.
- `src/daemon/routes.ts` — add three `/v1/inject-clients` endpoints (POST register, DELETE deregister, GET list). Update Q&A reply path to route via `injectClients` lookup instead of the tmux strategy.
- `src/daemon/server.ts` — write/delete `daemon.pid.json` sentinel on lifecycle. Pass `Clients` instance into `DaemonContext`.
- `src/daemon/lifecycle.ts` — instantiate `Clients`, pass into context.
- `src/daemon/sleeping.ts` — late-binding hook integration: when a sleep hook arrives with a session_id, also bind it (so sleep mode's autonomous claude could in theory use inject too — out of scope for v1, but the binding is automatic).
- `src/config/schema.ts` — `InjectConfig.strategy` type extends to `z.enum(['pty', 'tmux']).default('pty')`. Existing tmux flow unchanged for users who set `strategy: 'tmux'`.
- `src/cli/init.ts` — wizard simplifies: PTY is the default; ask `Habilitar Q&A (inject via PTY)? [Y/n]`. Tmux questions removed from the standard path; users can set the legacy strategy by hand if they really want.
- `package.json` — add `node-pty` dependency (~5MB, native binding; mature, used by VS Code).

## Behavior details

- **`node-pty` cross-platform:** Linux/macOS use `/dev/ptmx`; Windows ≥10 1809 uses ConPTY (the user is on Windows 11 — fully supported).
- **Raw stdin mode:** while claude runs, the CLI sets `process.stdin.setRawMode(true)` so keystrokes (including Ctrl+C, arrows, escape sequences) flow byte-by-byte into the PTY. On exit, raw mode is restored. If the CLI crashes without restoring, the user's terminal is in a weird state — call `process.stdin.setRawMode(false)` in process exit handlers + `SIGINT`/`SIGTERM` traps as defense in depth.
- **Ctrl+C behavior:** Ctrl+C goes through to claude (claude decides what to do). To kill the CLI process from outside, send `SIGTERM` from another shell (`kuroboto status` lists PIDs).
- **Resize:** CLI listens to `process.stdout.on('resize')` (Node fires it) and calls `pty.resize(stdout.columns, stdout.rows)`.
- **Local port:** allocated by OS via `listen(0)` — no port collisions.
- **HTTP local-only:** server binds to `127.0.0.1` exclusively; daemon's existing auth model (token in `X-Kuroboto-Token` header) is used for the `/inject` endpoint too.
- **No client-side state:** if the CLI crashes hard, `kuroboto status` shows it as registered until the next inject attempt; user can run `kuroboto inject prune` to clear stale entries (planned helper, optional v1).
- **Sleep mode interaction:** sleep mode still spawns its autonomous claude as a direct child (no PTY wrapping needed — autonomous claude isn't user-facing). Q&A in sleep mode remains out of scope (Spec B already excludes it).

## Failure modes

| Failure | Behavior |
|---|---|
| `node-pty` import fails / binding missing | CLI exits with `node-pty unavailable; reinstall kuroboto or use --tmux` |
| Daemon offline at CLI startup | CLI starts anyway; claude works without inject capability; CLI prints `⚠ daemon offline — Q&A replies won't reach this session until daemon is back`; `fs.watch` on sentinel re-tries register |
| Slug collision on registration | Daemon returns 409; CLI prints `slug "<name>" already in use by PID <other>`; exits non-zero |
| Sentinel write fails (disk full, permissions) | Daemon logs warn; daemon still starts; sentinel-watch fallback for restart-recovery is degraded but not broken (CLI registers once and stays) |
| CLI registration POST fails (network/auth) | CLI retries with backoff up to 3 times; if still failing, prints `⚠ failed to register with daemon: <err>` and continues without inject |
| Daemon to CLI inject POST fails (CLI dead) | Daemon removes the client + session bindings; sends fallback Telegram with the text; audit `qa-inject-failed` |
| `process.stdin.setRawMode` not supported (rare; non-TTY context) | CLI exits with `kuroboto claude must be run in a terminal; pipe input is not supported` |

## Audit

New `source` values:
- `client-registered` — CLI registered with daemon
- `client-deregistered` — CLI deregistered (clean exit) or pruned (stale)
- `inject-pty-sent` — successful PTY inject
- `inject-pty-failed` — POST to CLI failed at runtime

Existing `qa-injected` and `qa-inject-failed` are emitted by the existing Spec B flow, regardless of strategy (PTY or tmux); the new `inject-pty-*` are just the strategy-specific traces. Optional — could fold into existing.

## Out of scope (follow-ups, see `docs/specs-backlog.md`)

- **Multiple claudes per CLI process** — each `kuroboto claude` hosts exactly one claude. To run two, run two CLI processes.
- **CLI status UI** — claude already takes the screen; we don't draw any chrome on top. `⚠ daemon offline` is the only inline message.
- **Reconnect after CLI restart** — when CLI exits, the user re-runs `kuroboto claude` for a new session. No "resume previous claude" flow.
- **Inject for sleep mode** — autonomous claude is meant to be autonomous; if it pauses, it pauses. Same as Spec B's stance.
- **`kuroboto inject prune`** — manual stale-cleanup helper; can be added if `kuroboto status` shows too many ghosts.

## Test plan

**Unit (`injectClients.test.ts`):**
- `register({slug, pid, cwd, localPort})` — entry stored
- Duplicate slug → throws "slug already in use"
- `deregister(slug)` → entry removed plus all session bindings cleared
- `bindSessionToSlug(sid, slug)` — entry stored
- `bindSessionToSlug` when slug not in clients → throws
- `lookupBySession(sid)` returns `{slug, port}` if both maps populated
- `lookupBySession` with no binding → null

**Unit (`injectPty.test.ts`):**
- `injectViaPty(client, 'hello')` → POST 127.0.0.1:port/inject with text body
- 200 response → resolves
- 4xx/5xx response → rejects with reason
- Connection refused → rejects with reason
- Timeout (5s) → rejects with timeout reason

**Unit (`injectClient.test.ts`):** (mock node-pty, mock fetch)
- On startup, registers with daemon (POST /v1/inject-clients with current pid + cwd)
- Local server starts on a free port, route POST /inject writes to mock PTY
- On `pty.exit` event, sends DELETE /v1/inject-clients/<slug>, exits process
- Sentinel `fs.watch` change → triggers re-register
- Daemon offline → CLI starts anyway, prints warn, retries every N seconds via sentinel watch (no continuous polling — only fs events)
- Slug collision → exits non-zero with clear message

**Integration (`daemon.test.ts` extension):**
- Mock CLI process registers; daemon's GET /v1/inject-clients returns it
- Hook event with cwd matching registered CLI → late-binding stored
- Q&A pendingReply resolves → daemon POSTs to mock CLI's local port
- Mock CLI's local port goes down → daemon falls back to Telegram with the text + audits qa-inject-failed
- Daemon restart: sentinel rewritten → mock CLI's fs-watch fires → CLI re-registers

**Smoke (post-merge, manual):**
1. `kuroboto claude` (no `--tmux`) in plain Windows Terminal — claude runs as if native. Status bar of WT updates per claude's signals (no tmux interception).
2. From another terminal, ask claude something that requires free-text input ("escolha entre A e B").
3. Wait for Telegram notif with 💬 Reply button.
4. Tap Reply, type `A`, send.
5. Verify `A` appears as input in claude (in the Windows Terminal window). Telegram replies `✅ Reply injetada`.
6. Test daemon restart: in another shell `kuroboto stop && kuroboto start`. CLI process should print `daemon back, re-registered`. Repeat step 2-5 to confirm Q&A still works.
7. Test `--tmux` flag legacy path: `kuroboto claude --tmux` — verify tmux session is created and old flow still works.

## Tasks

1. **M1**: Create `src/inject/pty.ts`, `src/daemon/injectClients.ts`, `src/cli/injectClient.ts`. Add `node-pty` dep. Sentinel write/delete in `server.ts`. Unit tests (3 files).
2. **M2**: Daemon endpoints (`POST/DELETE/GET /v1/inject-clients`). Q&A reply routing in `routes.ts` switches from tmux strategy to `injectClients` lookup. Late-binding in hook handlers. Schema migration (`strategy: 'pty' | 'tmux'`, default `'pty'`). Init wizard cleanup. Integration tests.
3. **M3**: `--tmux` and `--name` flags on `kuroboto claude` CLI. Replace `claude.ts` exec path with `injectClient.run`. Manual smoke (PTY mode + tmux mode). PR.
