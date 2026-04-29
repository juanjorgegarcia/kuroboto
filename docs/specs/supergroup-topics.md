# Telegram supergroup + topics (one topic per session)

> Status: planned. Spec F. Pinned in backlog since the original UX overhaul series; promoted to formal spec because parallel Spec E sessions and multi-machine workflow make a flat DM chat increasingly noisy.

## Problem

Today the bot lives in a 1:1 DM with the user. Every kuroboto event (permission prompt, Q&A reply, gaming FYI, sleep start/done, desktop fallback, daemon errors) lands in the same flat scroll. With multiple Claude sessions running in parallel — different repos, different machines, sleep + interactive concurrently — messages from unrelated sessions interleave and the user has to mentally re-thread by reading headers.

The pinned fix has been: move from DM to a **private supergroup** (only the user in it) with **forum mode** enabled, and create one topic per session. Each session gets its own thread, scroll, name, and notification setting. Cross-session interleaving disappears at the chat-level instead of the user's head.

This unlocks naturally:
- **Multi-claude visual organization** — no more `[host / folder / "..."]` decoding to know who's asking
- **Per-session notification control** — mute the topic of a long-running sleep that spams commits
- **Closed/archived sessions** stay browsable as separate threads instead of disappearing into the scroll
- **Better foundation for multi-machine** — when the user runs kuroboto on both mac and Windows, both can post to the same supergroup with topics keyed by hostname-prefixed slug

This spec is independent of (but informed by) Spec E (PTY injection): both center on the **slug** identity that lets us route messages cleanly per session.

## Solution

Extend the existing `telegram` channel type with `forumMode: true`. When enabled, the daemon:

- Creates one topic per logical session, keyed by slug (Spec E client slug, sleep slug, or fallback chain)
- Routes every outbound message through `resolveTopic(payload)` to find/create the right topic and stamp `message_thread_id` on the API call
- Sends system events (daemon lifecycle, errors) to a dedicated `kuroboto-system` topic
- Validates bot permissions (`can_manage_topics`) on startup; refuses to start if missing
- Persists `slug → message_thread_id` mapping in `~/.config/kuroboto/topics.json` so daemon restarts don't recreate topics

DM mode (current default) is preserved — `forumMode` is opt-in. Existing users see no behavior change unless they migrate.

## Topic key resolution

For each outbound message, the daemon picks a topic key in this order:

| Source | Topic key | Topic name when created |
|---|---|---|
| Spec E client slug (interactive `kuroboto claude`) | the slug | `<slug>` (e.g., `fix-bot-ux`) |
| Spec E client slug + tmux mode | the slug | `<slug>` |
| Sleep mode slug | sleep slug | `💤 <slug-no-suffix>` (e.g., `💤 desktop-notifications`) |
| Direct `claude` (no kuroboto wrapper) | `session_id` | `<cwd-basename>-<sid8>` (e.g., `kuroboto-a3f9b2c1`) |
| System events (no session) | hardcoded `kuroboto-system` | `kuroboto-system` |

Lookup happens in `~/.config/kuroboto/topics.json` first; on miss, daemon calls `createForumTopic` and persists the result.

## Architecture

```
+-------------+    +--------------------+    +-------------------+
|  hook /     |    | resolveTopic(p):   |    | TelegramChannel   |
|  CLI route  +--->| - pick key         +--->| sendMessage(...   |
|             |    | - lookup map       |    |   message_thread_ |
|             |    | - createTopic if   |    |   id: id          |
|             |    |   miss + persist   |    |                   |
+-------------+    +--------------------+    +-------------------+
                          |
                          v
                  ~/.config/kuroboto/topics.json
                  { "fix-bot-ux": 42, "💤 ...": 127, "kuroboto-system": 1 }
```

## Files

**Create:**
- `src/channels/telegram/topics.ts` — `class TopicManager`. Methods: `resolve(key, name): Promise<message_thread_id>`, `purge(key)`, `loadFromDisk()`, `flushToDisk()`. In-memory cache + on-disk persistence to `topics.json`.
- `src/channels/telegram/forumValidation.ts` — `validateBotPermissions(api, chatId): Promise<void>`. Calls `getChatMember` for the bot's own ID; throws clear error if not admin or missing `can_manage_topics`.
- `test/unit/topics.test.ts` — TopicManager: cache hit, cache miss → create + persist, persist failure handling, purge.
- `test/unit/forumValidation.test.ts` — mock api responses for "not admin", "missing manage_topics", "ok".

**Modify:**
- `src/config/schema.ts` — extend telegram channel with optional `forumMode: z.boolean().default(false)`.
- `src/channels/telegram/api.ts` — `sendMessage`, `sendPrompt`, `sendQuestion` accept optional `messageThreadId: number` and pass it as `message_thread_id` body field on Telegram requests. New wrappers: `createForumTopic(chatId, name)` and `getChatMember(chatId, userId)`.
- `src/channels/telegram/TelegramChannel.ts` — every outbound call routes through `topicManager.resolve(key, name)` to get the thread id, then calls api with it. Adds a `bindContext({ slug?, sessionId?, cwd? })` context that callers populate so the channel can pick the right key. On `forumMode: false`, all this is a no-op (passes `undefined` for threadId, behavior is current DM mode).
- `src/daemon/lifecycle.ts` — instantiates `TopicManager` (loads topics.json), runs `validateBotPermissions` if `channel.forumMode === true`. Refuses to start on validation fail.
- `src/daemon/routes.ts` — every `channel.send*` call site is updated to pass the routing context (slug if known, session_id otherwise). Helper `topicContext(payload)` derives the right context from a hook payload + the daemon's `injectClients` map.
- `src/daemon/sleeping.ts` / `src/daemon/sleepFinish.ts` — same: pass slug context to channel calls.
- `src/cli/init.ts` — wizard branches: "DM (default) or supergroup with topics?". If supergroup chosen: instructions for creating supergroup, enabling forum mode, adding bot as admin, capturing chatId; runs validation before saving config.
- `src/config/paths.ts` — add `TOPICS_FILE = path.join(CONFIG_DIR, 'topics.json')`.

## Behavior details

- **Lazy topic creation.** Topics aren't pre-created on CLI register or sleep start. They're created when the first outbound message for that key fires. Saves API round-trips for sessions that don't generate Telegram traffic.
- **Reuse by slug.** If user runs `kuroboto claude --name fix-bot-ux` today, gets a topic `fix-bot-ux`. Tomorrow, runs the same — same topic, history preserved. (Sleep mode slugs include random suffix, so each dispatch gets a fresh topic — that's intended; sleep history is per-PR.)
- **Topic deleted in client.** Next outbound message attempt fails with `Bad Request: message thread not found` from Telegram. `TopicManager` catches this, purges the entry, and retries with `createForumTopic`. User sees a fresh topic; the old chat history is gone (matches what they did in the client).
- **System events** (daemon online/offline, channel errors, audit append failures, gaming arm/cancel, etc.) all route to `kuroboto-system`. Created lazily on first system event.
- **Persistence.** `topics.json` is written on every successful `createForumTopic` (small, ~hundred bytes per entry). File is plain JSON; user can hand-edit if they need to remap.
- **Permissions validation.** On startup with `forumMode: true`, daemon calls `getMe` to learn its own bot ID, then `getChatMember(chatId, botId)`. If `status !== 'administrator'` or `can_manage_topics !== true`, throws with a clear message including the Telegram link to fix it.
- **Migration is manual.** User edits config, restarts daemon. The doc walks them through the Telegram steps (create supergroup, enable forum, add bot, copy chatId).
- **Backwards compat.** `forumMode` defaults to `false`. Existing configs load and behave identically. `TopicManager.resolve(...)` returns `undefined` for thread id when `forumMode === false`, which propagates as `message_thread_id: undefined` (omitted from API call), and Telegram delivers to the main chat as today.

## Failure modes

| Failure | Behavior |
|---|---|
| `forumMode: true` but bot not admin | daemon refuses startup with link to bot settings |
| `forumMode: true` but bot missing `can_manage_topics` | same — refuse + clear instruction |
| `createForumTopic` fails (API error, rate limit) | log warn, skip topic for this message, fall back to main chat (no `message_thread_id`); retry on next message |
| `topics.json` write fails (disk full) | log warn; in-memory cache still works for this run; survives within the daemon process; lost on restart |
| Topic deleted in client mid-session | next message → 400 → purge + recreate (transparent to user) |
| Bot kicked from supergroup | daemon's polling errors out (existing channel-error path); user has to re-add bot |

## Audit

New `source` values:
- `topic-created` — fired when `createForumTopic` succeeds
- `topic-create-failed` — fired on `createForumTopic` 4xx/5xx
- `topic-purged` — fired when daemon detects a deleted topic and clears the entry

Existing audit values unchanged.

## Out of scope (follow-ups, see `docs/specs-backlog.md`)

- **Per-host slug prefix** (multi-machine: prepend `mac-juan/` or `win-juan/` to slug) — natural extension once multi-machine setup proves the need
- **Custom topic icons** (premium emoji or per-type colors) — cosmetic; v1 uses Telegram defaults
- **Auto-archive on session end** (Stop hook) — future ergonomic
- **`kuroboto topics list/prune`** CLI helpers — manual cleanup if `topics.json` drifts
- **Migration tool** — automated DM→supergroup, including reposting recent history
- **Inbound routing per topic** — for v1, force_reply already disambiguates Q&A replies via `reply_to_message`; the topic is just visual

## Test plan

**Unit (`topics.test.ts`):** (mock fs + mock api)
- `resolve('fix-bot-ux', 'fix-bot-ux')` first call → calls `createForumTopic`, persists `topics.json`, returns thread id
- Second call same key → cache hit, no api call
- `resolve` with `forumMode: false` → returns `undefined` (no api call)
- `purge('fix-bot-ux')` → removes from cache and from disk
- `loadFromDisk` with malformed json → starts empty (no throw)
- `flushToDisk` failure → logged, in-memory cache unaffected

**Unit (`forumValidation.test.ts`):**
- Mock api `getChatMember` returning `{ status: 'administrator', can_manage_topics: true }` → resolves
- Mock returning `{ status: 'member' }` → throws "bot is not an admin"
- Mock returning `{ status: 'administrator', can_manage_topics: false }` → throws "missing can_manage_topics"
- Mock api throws → throws with original error wrapped

**Unit (`api.test.ts` extension):**
- `sendMessage` with `messageThreadId: 42` → request body includes `message_thread_id: 42`
- `sendMessage` with `messageThreadId: undefined` → no `message_thread_id` field

**Integration (`daemon.test.ts` extension):**
- `forumMode: true` + interactive PreToolUse hook with cwd matching a registered CLI → mock channel receives sendPrompt with thread-id matching the slug's topic; topic is created lazily on first message
- `forumMode: true` + sleep mode start → sleep notif's sendNotification is called with the sleep-slug topic
- `forumMode: true` + system event (daemon online) → sendNotification with `kuroboto-system` topic
- `forumMode: false` → all messages have `messageThreadId: undefined` (current DM behavior)
- `forumMode: true` + bot lacks permissions → daemon throws on startup with clear error
- Topic deleted (api returns 400 message-thread-not-found) → next message recreates the topic, audit `topic-purged` + `topic-created`

**Smoke (post-merge, manual):**
1. Create a private supergroup; enable forum mode (Settings → Topics); add bot as admin with manage-topics permission
2. Copy supergroup `chatId` (negative number, starts with `-100...`)
3. Edit `~/.config/kuroboto/config.json`: set `chatId` to the new id, add `"forumMode": true`
4. `kuroboto stop && kuroboto start` — daemon validates and starts cleanly
5. Run `kuroboto claude --name proj-a` in one window, `kuroboto claude --name proj-b` in another
6. Trigger a Bash prompt in each — verify each lands in its own topic
7. Run `kuroboto sleeping start --plan something.md` — sleep notifs land in their own topic with `💤 ` prefix
8. Cause a daemon error (e.g., kill Telegram connectivity) — verify error msg lands in `kuroboto-system` topic
9. Delete the `proj-a` topic in the Telegram client; trigger another Bash in proj-a — verify a new topic is created (audit shows `topic-purged` + `topic-created`)

## Tasks

1. **M1**: Create `topics.ts` (TopicManager) and `forumValidation.ts`. Schema migration (`forumMode` field). Path constant for `topics.json`. Unit tests.
2. **M2**: Extend `api.ts` (`messageThreadId` parameter, new wrappers). Modify `TelegramChannel` to thread context through every outbound. Wire `routes.ts`/`sleeping.ts`/`sleepFinish.ts` to populate context. Lifecycle bot-permissions validation.
3. **M3**: Init wizard branch for supergroup setup. Integration tests. Manual smoke. PR.
