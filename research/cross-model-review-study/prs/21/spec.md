# CLI improvements bundle

> Status: planned. Spec I. A bundle of UX / housekeeping improvements that surfaced from real dogfood. Sized for one autonomous sleep run. None of these are urgent (the gaming-FYI flood was already hotfixed in PR #20); they're papercuts that compound.

## Problem (the papercuts)

Witnessed live in this dogfood week:

1. **PR titles from sleep mode are ugly slugs** — `bot prompt free text q a tmux inject yafbdj`, `cli layer tests status planned spec h npc6ub`. Every PR needs a manual rename before merge. The spec already has a clean title in its H1 (`# Bot prompt free-text Q&A (tmux inject)`).
2. **Worktree + branch cleanup is manual** — after `gh pr merge --delete-branch`, the local branch is held by the worktree → delete fails → manual `git worktree remove` + `git branch -D` every time.
3. **`ohayo` is locked into tmux** — Spec E shipped PTY-based wrapping; `ohayo` should drop tmux for a cleaner UX (no green status bar, no intercepted bell).
4. **Telegram-flood control is incomplete** — PR #20 stopped per-tool gaming FYIs during sleep, but there's no command to clean up flood damage that already happened.
5. **Daemon-down errors are silent** — when the daemon isn't running, every CLI command times out or shows "fetch failed" with no actionable message.
6. **No debug mode for diagnostics** — when something flooded Telegram or a CLI command misbehaved, there was no `--debug` to see HTTP traffic.

## Solution

A bundle of small, isolated commands and flags. Each is independently shippable but cheaper to build together (shared CLI plumbing, shared tests, single PR review).

### M1 — Slug → spec H1 for PR titles

`src/daemon/sleepFinish.ts:humanise(slug)` is currently:

```ts
function humanise(slug: string): string {
  return slug.replace(/-/g, ' ');
}
```

Replace with: read the first non-empty Markdown H1 from the spec content (passed via `prompt`/`plan`), strip the leading `# `, use that as the title. Fall back to `humanise(slug)` if no H1 is found (e.g., `--prompt` instead of `--plan`).

The slug already lives in branch + worktree paths and remains the slug (those are git-friendly identifiers); only the human-facing PR title changes.

### M2 — `kuroboto sleeping cleanup`

New CLI subcommand. Reads `gh pr list --state merged --head sleep/*` to find merged sleep PRs; for each:

- Run `git worktree remove <worktree-path>` (force if needed)
- `git branch -D <local-branch>` (force, since squash merge leaves the branch unmerged from main's POV)
- `git fetch --prune` to drop the stale remote ref

`--dry-run` flag lists what would be cleaned without doing it.

Output:

```
$ kuroboto sleeping cleanup
3 merged sleep branches to clean:
  • sleep/feat-x-abc123     PR #N (merged)  → worktree, local branch, remote
  • sleep/feat-y-def456     PR #M (merged)  → worktree, local branch
  • sleep/feat-z-ghi789     PR #K (merged)  → already partially clean
cleanup? [y/N]
```

`--yes` to skip the prompt. Non-zero exit on any failure.

### M3 — `kuroboto topics clear` (supergroup mode only)

Two variants:

- `kuroboto topics clear <slug>` — calls `deleteForumTopic` API for the slug's `message_thread_id`, purges the entry from `topics.json`. Next outbound message for that slug recreates the topic fresh.
- `kuroboto topics clear --all` — same for every entry in `topics.json` except `kuroboto-system` (system topic stays). Confirmation prompt lists everything before delete.

Refuses with a clear message when `forumMode: false` (DM mode has no topics; use `kuroboto chat clear` instead).

`--dry-run` shows what would be deleted.

### M4 — `kuroboto chat clear --last N` (any mode)

Deletes the last N messages the bot sent (tracked from outbound message IDs the daemon already collects for keyboard editing). Bounded by Telegram's 48h delete window — older messages can't be deleted by bots.

Output:

```
$ kuroboto chat clear --last 100
deleted 87 of last 100 (13 outside 48h delete window)
```

### M5 — `ohayo` in PTY mode (drop tmux)

Refactor `src/cli/ohayo.ts`:

- Remove `tmuxAvailable`, `tmuxHasSession`, send-keys, attach-session
- Print `ohayo 🌅` greeting
- Ensure daemon is up (existing logic from `src/cli/claude.ts`'s daemon-ensure)
- Call `runInjectClient({ args: [] })` directly (PTY wrapper from Spec E)
- `--tmux` flag for legacy users who want the detachable session

Trade-off: closing the terminal kills the claude session (vs. tmux's detachable behavior). Acceptable for v1; users who want detachability use `--tmux`.

### M6 — Daemon-down errors

When any CLI HTTP call fails with `ECONNREFUSED` (or fetch's equivalent), CLI prints:

```
✗ daemon offline. start it with `kuroboto start -d`.
```

…and exits 1. No more silent timeouts or generic "fetch failed".

Helper in `src/cli/http.ts` (new): `kuroFetch(url, init)` wraps `fetch`, catches connection errors, prints the message + exits.

### M7 — `--debug` global flag

Every CLI subcommand accepts `--debug`. When set:
- HTTP request URL + method + body printed to stderr before each fetch
- Response status + body printed after
- Daemon-side: not affected (daemon already logs)

Implementation: a `debug` boolean threaded through `kuroFetch` from M6. No environment-variable form for now (YAGNI).

### M8 — `--dry-run` on destructive commands

`sleeping cleanup`, `topics clear`, `chat clear` accept `--dry-run` flag. When set, list what would be done; no API calls or fs writes. Exit 0.

## Files

**Create:**
- `src/cli/sleepingCleanup.ts` — M2 logic
- `src/cli/topicsClear.ts` — M3 logic
- `src/cli/chatClear.ts` — M4 logic
- `src/cli/http.ts` — `kuroFetch` helper (M6 + M7)
- `test/unit/cli/sleepingCleanup.test.ts`
- `test/unit/cli/topicsClear.test.ts`
- `test/unit/cli/chatClear.test.ts`
- `test/unit/cli/kuroFetch.test.ts`

**Modify:**
- `src/cli/index.ts` — register new subcommands + `--debug` global option
- `src/cli/sleeping.ts` / `gaming.ts` / `audit.ts` / `allowlist.ts` / `mode.ts` — switch to `kuroFetch` for daemon-down errors + debug
- `src/cli/ohayo.ts` — M5 refactor
- `src/daemon/sleepFinish.ts` — M1: `humanise` → spec H1 extraction
- `src/channels/telegram/topics.ts` — M3 backend: `purge(key)` already exists; add `purgeAll()` if not, expose for CLI to call via daemon HTTP endpoint
- `src/daemon/routes.ts` — new endpoints:
  - `POST /v1/topics/clear` body `{ slug?: string, all?: boolean }` → returns deleted count
  - `POST /v1/chat/clear` body `{ last: number }` → returns deleted count
- `src/channels/telegram/api.ts` — `deleteMessage(chatId, messageId)` wrapper for M4
- `src/channels/Channel.ts` — interface extension for `deleteMessage` + `clearTopics`

## Behavior details

- **PR title H1 extraction:** scan plan content (or PLAN_INTRO + plan), find first line matching `^#\s+(.+)$`, capture group → trim → use as title. If no H1 in first 50 lines, fall back to humanised slug. Truncate to 70 chars (GitHub PR title limit is generous but keep it sane).
- **Cleanup safety:** `sleeping cleanup` only acts on `sleep/*` branches whose corresponding PR is merged. Open PRs are skipped (printed as "skipped: PR open"). Never deletes `main` or other non-sleep branches.
- **Topics clear behavior:** when topic is deleted via API, Telegram fires no event back; the daemon trusts the success response and removes from `topics.json` immediately. Next message recreates lazily (existing behavior).
- **Chat clear bounded:** Telegram's `deleteMessage` only succeeds for messages < 48h old when called by a bot. Older messages return `Bad Request: message can't be deleted`. CLI counts successes vs failures, reports both.
- **`--debug` output:** to stderr, not stdout, so command output remains pipeable. Format: `[debug] POST http://127.0.0.1:47891/v1/sleeping {body...} → 200 {response...}`.
- **Daemon-down detection:** matches on `ECONNREFUSED` (Node fetch) and `ETIMEDOUT` (slow network); prints actionable error and exits 1. Other HTTP errors keep current behavior.

## Out of scope

- **Auto-cleanup hook on PR merge** — `kuroboto sleeping cleanup` is invoked manually for now. Auto-detection (file watch on `gh` API webhooks) would close the loop but adds complexity. Promote to spec only if manual cleanup feels recurring.
- **Sleep state persistence** (daemon restart kills autonomous claude) — deferred to its own spec; bigger lift than the rest of this bundle.
- **Per-tool FYI denylist** during manual gaming — PR #20 stopped sleep flood; user-armed gaming still floods if they run a script. Add config option `policy.gamingFyiSkip: string[]` if it bites.
- **Status aggregator** (`kuroboto status` showing sleeps + clients + topics in one view) — independent improvement, deserves its own thinking.

## Test plan

**Unit:**
- `sleepingCleanup.test.ts` — mock `gh` + `git` calls; verify it filters merged-only, runs the right commands, respects `--dry-run`
- `topicsClear.test.ts` — mock daemon HTTP; verify it POSTs the right body, prints the right output
- `chatClear.test.ts` — mock daemon HTTP; verify count parsing
- `kuroFetch.test.ts` — mock fetch with ECONNREFUSED; verify the error message + exit code

**Integration (`daemon.test.ts` extension):**
- `POST /v1/topics/clear { slug }` → calls `topicManager.purge(slug)` once with the right key
- `POST /v1/topics/clear { all: true }` → calls purge on every key except `kuroboto-system`
- `POST /v1/chat/clear { last: 10 }` → calls `deleteMessage` 10 times with last 10 sent IDs

**Smoke (post-merge, manual):**
1. Open a PR via sleep dispatch — verify the title is the spec's H1, not the slug
2. Merge a sleep PR; run `kuroboto sleeping cleanup` — worktree + branches deleted
3. In supergroup mode, dispatch a sleep that floods a topic; run `kuroboto topics clear <slug>` — topic disappears, next message recreates
4. Stop the daemon; run `kuroboto sleeping status` — clear "daemon offline" error, exit 1
5. Run `kuroboto sleeping status --debug` — see HTTP request/response on stderr
6. Run `kuroboto ohayo` — claude opens in current terminal directly, no tmux session created

## Tasks

1. **M1**: Implement spec-H1 PR title extraction in `sleepFinish.ts` + unit test. Independent of others; can ship first.
2. **M2 + M3 + M4**: New CLI commands (`sleeping cleanup`, `topics clear`, `chat clear`) + new daemon endpoints + tests. The three share most plumbing.
3. **M5**: `ohayo` PTY refactor. Drops tmux dependency from that path.
4. **M6 + M7 + M8**: `kuroFetch` helper, `--debug` global, `--dry-run` flags. Wire through every existing CLI command.
5. **Final**: Run full suite (target: ~330 tests), manual smokes, PR.
