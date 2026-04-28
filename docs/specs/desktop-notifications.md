# Desktop notifications on sleep finish

> Status: planned. Spec C of "bot UX overhaul" series (after `prompt-context.md` + `prompt-freetext-qa.md`).

## Problem

Today the only signal that a sleep session finished is the Telegram message `✅ sleep done — PR: <url>...` sent from `src/daemon/sleepFinish.ts`. If the user isn't actively watching their phone (working at the desk, in another room, in a meeting), the sleep can finish unnoticed for hours. We saw this happen live during dogfooding: PR #10 opened at 18:34, but the user only noticed ~30 minutes later when manually checking.

The fix is a desktop notification — a native OS toast that pops on whatever screen is in front of the user, regardless of what they're focused on. This matches the use case: kuroboto users sit at their desk and dispatch sleep, then context-switch to other work. A desktop toast is the right surface for "your background task finished."

## Solution

When a sleep session finishes (success **or** failure), the daemon fires a desktop notification in addition to the existing Telegram message. The two are independent — Telegram remains for "you're away from desk," desktop is for "you're at the desk but not watching the chat."

Library: [`node-notifier`](https://github.com/mikaelbr/node-notifier) — cross-platform (Windows Toast / macOS NotificationCenter / Linux libnotify), zero native deps, ~5 transitive deps, mature.

Config: `notifications.desktop: boolean` — single toggle. Default `true` for new installs (init wizard prompts; user can opt out). Default `false` if the field is missing from an existing config (backwards-safe — silent migration).

## Files

**Create:**
- `src/notify/desktop.ts` — `notifyDesktop(opts: { title, body, level: 'success' | 'error' }): Promise<void>`. Wraps `node-notifier`. Swallows errors (silent fail with debug log — never breaks sleep flow).
- `test/unit/desktopNotify.test.ts` — unit tests with mocked `node-notifier`.

**Modify:**
- `src/daemon/sleepFinish.ts` — after the existing `channel.sendNotification(...)` call, also call `notifyDesktop(...)` if `config.notifications.desktop === true`. Both fire-and-forget; failures don't propagate.
- `src/config/schema.ts` — add `NotificationsConfig = z.object({ desktop: z.boolean().default(false) })` and wire into root `Config`. Default in schema is `false` (backwards-safe); init wizard sets `true` for new installs.
- `src/cli/init.ts` — wizard step: "Enable desktop notifications when sleep finishes? [Y/n]". Default Y.
- `package.json` — add `node-notifier` as a dependency.
- `src/daemon/audit.ts` (touched only in audit emission paths) — no schema changes; new `source` values listed below.

## Behavior details

**Notification content:**

| Event | Title | Body |
|---|---|---|
| Sleep success (PR opened) | `kuroboto: sleep done` | `${slug} → PR #${num}` |
| Sleep success (no PR — couldn't open one, e.g., gh failed) | `kuroboto: sleep done` | `${slug} (no PR — see worktree)` |
| Sleep failure (timeout) | `kuroboto: sleep timeout` | `${slug} ran ${maxDuration}, no PR` |
| Sleep failure (error) | `kuroboto: sleep error` | `${slug}: ${err.message}` |

**Notification level → icon/sound:**
- `node-notifier` doesn't expose level directly, but it does expose `sound: true | string` (Mac/Win 8+) and `wait: false`. Use `sound: true` for failures, `sound: false` for success — failures should ping audibly, success is informational.

**Click action:** none for v1. The notif is purely informational. (Hooking click → open PR URL in browser is a follow-up; out-of-scope.)

**Order of operations in `sleepFinish.ts`:**
1. Existing: `channel.sendNotification(telegramText)` — fire-and-forget, await with `.catch(log)`
2. **NEW:** `notifyDesktop(...)` — fire-and-forget, await with `.catch(log)`

Both run concurrently. If either fails, the other still fires. Sleep state cleanup proceeds regardless.

**Config migration:** when an existing config (without `notifications.desktop`) is loaded, the schema's default `false` kicks in — user sees no behavior change. The init wizard only writes `true` for fresh installs. Users who want to enable retroactively can run `kuroboto init` again (it offers to merge into existing config) or hand-edit `~/.config/kuroboto/config.json`.

**Failure handling:**

| Failure | Behavior |
|---|---|
| `node-notifier` throws synchronously (rare) | Silent + debug log; sleep flow unaffected |
| `node-notifier.notify()` returns error in callback | Silent + debug log |
| OS notification daemon not running (Linux without libnotify) | `node-notifier` fails internally → debug log; never crashes |
| `notifications.desktop: false` | Function isn't called at all |

## Audit

New `source` values:

- `desktop-notif-sent` — successful desktop notification
- `desktop-notif-failed` — `node-notifier` returned an error

Existing values unchanged.

## Out of scope (follow-ups, see `docs/specs-backlog.md`)

- **Click → open PR URL** — adds interactivity; the v1 is passive informational.
- **Desktop notif on other events** — sleep start, mid-commit, permission prompts in away mode. Add only if a real demand emerges.
- **Extensible finish-hooks** (Level 2) — `policy.sleepFinishHooks: string[]` config-driven shell commands fired on sleep events. Backlogged separately because it's an architecture-shift, not a one-off feature.
- **Auto-cleanup of finished sleep worktrees** — also backlogged; orthogonal to notifications.

## Test plan

**Unit (`desktopNotify.test.ts`):** (mock `node-notifier`)
- `notifyDesktop({ title, body, level: 'success' })` → calls `notify` with `sound: false`
- `notifyDesktop({ title, body, level: 'error' })` → calls `notify` with `sound: true`
- `node-notifier.notify` errors → `notifyDesktop` resolves (does not reject), debug log captured
- Long body (>200 chars) → passed through (OS truncates as needed)

**Integration (`daemon.test.ts` — extend existing sleep tests):**
- `notifications.desktop: true` + sleep success → mock `notifyDesktop` called once with `level: 'success'` and body containing the slug
- `notifications.desktop: true` + sleep timeout → mock `notifyDesktop` called once with `level: 'error'` and body containing `"timeout"`
- `notifications.desktop: false` → mock `notifyDesktop` never called
- Mock `notifyDesktop` rejects → sleep finish flow still completes (Telegram still sent, state cleared)

**Smoke (post-merge, manual):**
1. On Windows: `kuroboto init` (or hand-edit `~/.config/kuroboto/config.json` to set `notifications.desktop: true`)
2. Dispatch a tiny sleep (e.g., a no-op spec) and wait for it to time out or finish
3. Confirm Windows Toast pops with the slug + PR info
4. Same on macOS (NotificationCenter banner)
5. Disable: set `notifications.desktop: false`, dispatch again, confirm no toast

## Tasks

1. **M1**: Add `node-notifier` dep, create `src/notify/desktop.ts` + unit tests.
2. **M2**: Wire into `src/daemon/sleepFinish.ts`. Add config schema + init wizard step. Integration tests.
3. **M3**: Manual smoke on Win + Mac. PR.
