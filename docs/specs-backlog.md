# Specs backlog

Loose collection of feature ideas worth a spec eventually. Not prioritized; promote to `docs/specs/<name>.md` when ready to design properly.

## Active queue (specced, ready to dispatch)

- **Spec G — Bug C watchdog** (`docs/specs/bug-c-watchdog.md`, 2026-04-29). Daemon auto-recovery via parent-child watchdog process. Foundational for status UI integration; touches `start.ts`/`stop.ts`/`status.ts`. v1 magro: respawns daemon on death, sleeps in-flight orphaned with cleanup notif.
- **Spec H — Daemon health UI** (`docs/specs/daemon-health-ui.md`, 2026-04-29). `kuroboto status` enriched with gaming/sleeps/inject/topics/watchdog. New `/v1/status` endpoint, `--json`/`--watch`/`--quiet` flags. Has overlap with Spec G in `cli/status.ts` — dispatch Spec G first, then rebase Spec H atop merged G to avoid conflicts.

## ForumMode v2 rollout (consolidated follow-ups)

Three small follow-ups from Spec F (`docs/specs/supergroup-topics.md`, merged in PR #14) that are good candidates for one consolidated spec when forumMode is actually enabled in production and the real ergonomic gaps surface:

- **Per-host slug prefix** (multi-machine: prepend `mac-juan/` or `win-juan/` to slug) — natural extension once multi-machine setup proves the need. Today the user develops between mac and Windows (per memory `project_multi_machine.md`); enabling forumMode without per-host prefix means same slug across hosts collides into the same topic. Becomes pressing the day forumMode is flipped on.
- **`kuroboto topics list/prune` CLI helpers** — manual inspection/cleanup of `topics.json` when it drifts from actual Telegram state (topic deleted in client, topics.json out of sync). Today the recovery path is hand-edit JSON; not ideal but rare.
- **Auto-archive on Stop hook** — when a Claude session ends (Stop hook fires), close the corresponding topic so the user's topic list doesn't grow unbounded across days/weeks of work. Cosmetic but the "close" action in Telegram already exists; just needs wiring.

These three touch the same `TopicManager` + `topics.json` + slug derivation surface and would naturally fit one PR. Consolidate into `docs/specs/forum-mode-v2.md` when (a) the user has been on forumMode for a few days and (b) at least one of the three has surfaced a concrete annoyance worth fixing.

Out of scope of this consolidated spec (kept separate for complexity reasons): **Migration tool DM→supergroup** — automated migration including reposting recent history. Heavier; manual migration is fine for now since it's a one-time operation.

## Extensible sleep finish-hooks (Level 2 of desktop notifications)

After Spec C ships native desktop notifications (`docs/specs/desktop-notifications.md`), the natural next step if other notification surfaces are wanted is a generic hook system:

- New config: `policy.sleepFinishHooks: string[]` — each entry is a shell command the daemon executes when a sleep session finishes
- Result data passed to hooks via stdin (JSON: `{ slug, branch, prUrl?, status: 'success'|'timeout'|'error', durationMs }`) and/or env vars (`KUROBOTO_SLEEP_*`)
- User-defined hooks: ping a Slack webhook, play a sound (`afplay /path/to/sound.mp3`), open the PR in browser (`open <url>`), update a kanban, etc.
- Failure handling: each hook runs with a short timeout; failures are audited but don't break sleep flow

This is **YAGNI today** — a single config toggle for desktop notifications covers the immediate pain. Promote to a real spec only when (a) someone wants a second hook surface and (b) hardcoding it in the daemon (like Spec C does) starts feeling wrong.

## Auto-cleanup of finished sleep worktrees

Every sleep that lands a merged PR currently leaves orphan state behind:

- Worktree at `~/.kuroboto/worktrees/<slug>-<rand>` (file content + `.git` ref)
- Local branch `sleep/<slug>-<rand>` that the worktree pins (so `gh pr merge --delete-branch` can't remove it)

Witnessed live on PR #10 merge: `gh pr merge` failed to delete the branch because the worktree was holding it. Manual `git worktree remove` + `git branch -D` was needed.

Possible solutions (pick one or combine):

- **Option A — Daemon-side:** when sleep finish detects the PR was merged (poll `gh pr view <num> --json state` after open), automatically prune the worktree + branch. Requires the daemon to keep watching the PR after open, which extends sleep state lifetime.
- **Option B — CLI subcommand:** `kuroboto sleeping cleanup` runs `git worktree list` + `gh pr view` for each `sleep/*` branch, deletes worktrees whose PR is merged. User invokes manually after merge sweeps. Lightweight.
- **Option C — Post-merge hook (depends on Level 2 above):** define a hook that triggers cleanup on merge.

Recommend **B** as the simplest: opt-in cleanup the user runs when convenient. Promote to spec if it becomes a daily annoyance.

## Morpheus skill — workflow-stage tracking

Complementary to the daemon's `kuroboto sleeping status` (which only shows sleep-mode state). The morpheus skill should also track its own workflow stages across dispatches:

- File: `~/.claude/skills/morpheus/runs.jsonl` (or similar)
- Each entry: `{ id, slug, repo, plan, dispatchedAt, prUrl?, stage: 'sleeping'|'review-pending'|'merged'|'cancelled' }`
- Updated on dispatch (write entry), on PR open (set `prUrl`, advance to `review-pending`), on merge (advance to `merged`), on cancel (advance to `cancelled`)
- New skill subcommand: `morpheus list` — shows all runs in flight
- Useful when juggling 2+ specs across repos: "what was I waiting on?"

Out of scope of Spec D (which is daemon-side parallelism only). Promote to spec when the parallel sleeps make this annoyance real.

## Sleep state persistence across daemon restart

Witnessed live during Spec C dispatch: daemon was restarted (SIGINT then start) while a sleep session was running. The autonomous Claude child process died with the daemon, M1 work was partially complete in the worktree but not committed, and the daemon came back up with `sleep: idle` — the sleep state was lost entirely.

Today's design treats sleep state as in-memory only:

- `SleepingOrchestrator.session` is a private field on the instance
- The child process is parented to the daemon — when daemon dies, child dies (or is orphaned without anyone watching its exit)
- The max-duration timer is `setTimeout` — also lost on restart
- The worktree + branch + partial work are left behind on disk, but the orchestrator has no way to know they exist

Possible designs:

- **Option A — On-disk state**: write `~/.kuroboto/sleep-state.json` on every state change. On daemon start, attempt resume:
  - If child PID still alive → re-attach exit handler + re-arm remaining timer
  - If child dead but worktree dirty → notify user (`⚠️ sleep recovery: <slug> died during daemon restart, worktree at <path> for inspection`); leave for manual cleanup
  - If everything dead and clean → drop the entry
- **Option B — Detached child + IPC**: spawn the autonomous Claude detached from the daemon (so it survives daemon restart). Use a unix socket or named pipe for the daemon to re-attach on restart. More complex, more reliable.
- **Option C — Status quo + better warning**: don't try to resume; just detect orphaned worktrees on daemon start and notify the user so they can clean up manually. Cheapest.

Recommend **A** — modest complexity, big reliability win. Promote to spec if daemon restarts during sleep happen more than once.

## Multi-claude per CLI process

Spec E (PTY injection) hosts exactly one claude per `kuroboto claude` invocation. To run two claudes the user runs two CLI processes. If a real "single wrapper, multiple claudes" workflow emerges, the CLI would need:
- Pane management (split / new / focus) — essentially a mini-tmux
- Per-pane PTY + per-pane HTTP route (or one HTTP server with `?pane=X` param)
- Some keybinding to switch between panes

YAGNI today — running multiple terminal windows is fine.

## Smaller follow-ups (from out-of-scope sections of shipped specs)

- **Cached transcript reads** with `mtime` invalidation. Premature optimization at our scale; revisit if `transcript.ts` reads become a bottleneck.
- **User-named session slugs** via env var override (e.g., `KUROBOTO_SESSION=fix-auth`). Wait until the auto-extracted "first user message" proves insufficient.
- **Multi-Claude tmux mapping** (`inject.cwdMappings: { cwd → tmux-session }`). Likely obsoleted by supergroup + topics + smarter injection.
- ~~**PTY-based injection** to drop the tmux dependency for free-text Q&A.~~ Promoted to `docs/specs/pty-injection.md` (Spec E).
- **Configurable `QA_PATTERNS`** via config. Wait until a real second pattern emerges.
- **Inject for sleep mode** (write to child_process stdin instead of tmux). Sleep is autonomous by design; revisit only if "sleep that occasionally asks the user" becomes a real workflow.
