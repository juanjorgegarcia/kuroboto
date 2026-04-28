# Specs backlog

Loose collection of feature ideas worth a spec eventually. Not prioritized; promote to `docs/specs/<name>.md` when ready to design properly.

## Telegram supergroup + topics (one topic per session)

> Pinned: planned next, after `prompt-context.md` + `prompt-freetext-qa.md` ship.

Current bot setup is a 1:1 DM. With multiple Claude sessions in flight (multiple machines, multiple repos, sleep + interactive in parallel), the chat becomes a flat stream where messages from different sessions interleave.

Telegram **supergroups with forum mode** allow a chat to be split into named topics (threads), each with its own scroll, name, and notification settings. Move the bot's destination from DM to a private supergroup (only the user in it). Then create one topic per `session_id` (or per `cwd`/sleep slug), so messages from each session live in their own thread.

**Sketch:**
- New `channel.telegram.chatType = 'supergroup'` with `forum_topics: true`
- Daemon maintains an in-memory map `session_id → topic_id`
- On first message of a session, create topic via `createForumTopic` API with name from session header (e.g. `kuroboto / "fix the bot UX"`)
- All subsequent messages for that session use `message_thread_id`
- On session end (Stop hook + idle threshold), optionally close/archive the topic

**Open questions:**
- Topic naming when first message is a permission prompt (no first-user-msg yet)? Maybe lazy-rename when transcript is readable
- TTL/cleanup policy for orphan topics
- Migration path from DM mode (config flag, manual setup of supergroup, BotFather permissions)

This unlocks multi-Claude UX naturally and reduces the need for tmux multi-mapping (Spec B's open follow-up).

## Smaller follow-ups (from out-of-scope sections of shipped specs)

- **Cached transcript reads** with `mtime` invalidation. Premature optimization at our scale; revisit if `transcript.ts` reads become a bottleneck.
- **User-named session slugs** via env var override (e.g., `KUROBOTO_SESSION=fix-auth`). Wait until the auto-extracted "first user message" proves insufficient.
- **Multi-Claude tmux mapping** (`inject.cwdMappings: { cwd → tmux-session }`). Likely obsoleted by supergroup + topics + smarter injection.
- **PTY-based injection** to drop the tmux dependency for free-text Q&A. Larger lift; tmux works for the current setup.
- **Configurable `QA_PATTERNS`** via config. Wait until a real second pattern emerges.
- **Inject for sleep mode** (write to child_process stdin instead of tmux). Sleep is autonomous by design; revisit only if "sleep that occasionally asks the user" becomes a real workflow.
