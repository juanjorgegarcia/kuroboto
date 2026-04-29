# Sleep/gaming noise filter + progress relay

> Status: planned. Spec J. Two paired changes that fix the same papercut: during gaming/sleep, the daemon currently floods Telegram with notifications that aren't actionable, and the dev simultaneously has zero mid-flight visibility into what claude is doing. Suppress the noise; restore visibility through structured progress markers.

## Problem (the flood + the blackout)

Witnessed live during recent dogfood:

1. **Notifications pour through during gaming/sleep.** `src/daemon/routes.ts:305` (`/v1/notify`) only special-cases Q&A typing prompts (`isQAPrompt(message)`); everything else — "Claude needs your permission to use Bash", progress notes, etc. — falls through to `sendNotification` and lands in Telegram. PR #20 already suppressed *gaming-FYIs during sleep*, but `/v1/notify` was untouched. Net effect: gaming/sleep don't quiet the channel the way the user expects from a "shift-tab" mode.
2. **Sleep claude is launched in default permission mode.** `src/daemon/sleeping.ts:136` spawns `claude -p <prompt>` with no permission flag. Claude fires PreToolUse for every tool — daemon auto-allows because gaming is armed, but the round-trip is wasted, and claude's *own* notification hook still fires "Claude needs permission..." style messages that route to Telegram via point 1.
3. **Dev goes blind during long sleeps.** `sleepFinish.ts` only notifies on completion ("✅ sleep done — PR: …") or failure. Nothing in between. With the filter from points 1+2 enabled the channel goes silent for the whole run; without it, it floods. Neither is what the dev wants — they want a small, structured trickle of "what's happening now."

## Solution

Three small, coordinated changes:

### J1 — Filter `/v1/notify` during gaming or sleep

In `/v1/notify` (`src/daemon/routes.ts:305`), before the existing branch:

```ts
const gamingActive = ctx.state.gaming.snapshot().active;
const sleepActive = ctx.state.sleeping.snapshot().active.length > 0;
if ((gamingActive || sleepActive) && !shouldHandleAsQA(payload, ctx) && !isProgressMarker(payload.message)) {
  ctx.logger.info('notify suppressed (gaming/sleep, non-Q&A)', { cwd: payload.cwd });
  res.json({ ok: true, suppressed: true });
  return;
}
```

Q&A typing prompts (the user explicitly asked for these to keep coming through) bypass the filter. Progress markers (J3 below) also bypass — they are the explicit visibility signal. Everything else is dropped with a daemon-side log entry so it can be diagnosed without spamming the user.

### J2 — `--dangerously-skip-permissions` on sleep spawn

`src/daemon/sleeping.ts:136`:

```ts
const child = this.deps.spawn(
  'claude',
  ['--dangerously-skip-permissions', '-p', finalPrompt],
  { cwd: worktreePath },
);
```

Equivalent to the user hitting shift-tab twice in interactive mode: claude doesn't fire the PreToolUse hook at all. Daemon stops receiving permission round-trips during sleep. `--dangerously-skip-permissions` is the documented Claude Code CLI flag for this; verify in the implementing run that the flag still exists at the current claude version (test by running `claude --help` on the sleep host).

The daemon's `policy.permissionMatchers` and gaming auto-allow logic remain in place for *non-sleep* use (manual gaming, away mode); only the sleep spawn path opts out.

### J3 — Stdout-marker progress relay

The daemon already spawns claude with default `stdio: 'pipe'` (Node default), so `child.stdout` is a Readable stream — currently nobody reads from it, which is also a latent bug because once the OS pipe buffer fills, claude blocks. Wire it up properly:

1. Attach a line-buffered reader on `child.stdout` (and `child.stderr` for completeness).
2. Each line is matched against:

   ```ts
   const MARKER_RE = /^\s*\[\[KUROBOTO\]\]\s+(.+?)\s*$/;
   ```

3. If a line matches, capture group 1 is the message. Forward it as a Telegram notification in the slug's topic context (`{ slug, isSleep: true }`), prefixed with `📍` so it's visually distinct from start/done.
4. Lines that don't match are ignored (claude's normal output remains uncaptured — the existing fire-and-forget behavior). Log them at debug level for diagnosis.

Embed in `PLAN_INTRO` (top of `sleeping.ts`):

```text
Execute this implementation plan. Follow it task-by-task. Run tests, commit per task,
and create a final summary at the end.

You are running unattended in a sleep session. Emit progress markers so the dev can
follow along without seeing every tool call. Use this exact format, one per line, on
a line by itself:

[[KUROBOTO]] <one-line update>

Emit a marker:
- after each task is committed: "[[KUROBOTO]] task N done: <what changed>"
- when you hit a blocker that needs human intervention: "[[KUROBOTO]] blocked: <why>"
- at the very end as the final summary: "[[KUROBOTO]] summary: <bullets>"

Keep markers short — one line each, no markdown. They land directly in Telegram.

```

For prompt-mode (no plan), append the same instruction block after the user's prompt so claude has the same protocol regardless of entry point.

## Files

**Modify:**
- `src/daemon/sleeping.ts` —
  - Update `PLAN_INTRO`; introduce `PROMPT_OUTRO` with the marker protocol; append it when `req.prompt` is used (so prompt mode also reports).
  - Spawn args: prepend `--dangerously-skip-permissions` (J2).
  - Wire `child.stdout` + `child.stderr` to a line-buffered parser; on `[[KUROBOTO]] <msg>` match call `deps.notify(\`📍 ${msg}\`, { slug, isSleep: true })` for the session.
- `src/daemon/routes.ts` — add gaming/sleep filter at the top of `/v1/notify` (J1).
- `src/daemon/notificationDetect.ts` — add `isProgressMarker(message)` helper (matches the same `[[KUROBOTO]]` regex on a single line). The notification hook itself shouldn't carry markers (claude prints them to stdout, not to Notification hook), but defending in depth is cheap.

**Create:**
- `test/unit/sleepReportRelay.test.ts` — line-buffered parser unit test: chunked stdout (split mid-line, multiple markers per chunk, mixed with non-marker lines) all parse correctly; non-matching lines are ignored; multiple concurrent sessions don't cross-contaminate.
- `test/unit/notifyFilter.test.ts` — `/v1/notify` integration: gaming-only active → non-Q&A suppressed, Q&A passes; sleep-only active → same; both-off → all pass; progress-marker payload → passes regardless of mode.

**Modify:**
- `test/unit/sleeping.test.ts` — extend with: spawn args include `--dangerously-skip-permissions`; PLAN_INTRO contains marker protocol; PROMPT_OUTRO appended for prompt-mode.

## Behavior details

- **Filter granularity:** gaming OR sleep is enough to enable the filter. The dev can still get noisy notifications during normal `here`/`away` mode — those are the modes where Telegram volume is acceptable because the dev armed them deliberately.
- **Marker regex strictness:** `^\s*\[\[KUROBOTO\]\]\s+(.+?)\s*$` requires the marker on a line by itself. Avoids false positives in claude's narrative output ("I'll emit a [[KUROBOTO]] marker now…"). Tests cover that.
- **Buffer safety:** the line-buffered reader uses `readline.createInterface({ input: child.stdout })`. Lines longer than the default 64KB threshold are truncated by readline silently — acceptable for one-line markers.
- **Backpressure:** consuming stdout fixes the latent buffer-fill bug. No code today depends on stdout being unread.
- **Crash isolation:** if the parser throws (it shouldn't — readline + regex), it must not bring down the orchestrator. Wrap the line handler in try/catch with a `logger.warn`.
- **Concurrent sessions:** each `InternalSession` owns its own `child` and therefore its own stdout. The slug is captured in the session closure, so cross-talk is structurally impossible. Test asserts this anyway.
- **Markers during cancellation:** if a session is cancelled mid-run, a final marker emitted by claude before the SIGTERM lands could race the cancel notification. Acceptable — the cancel notification ("sleep cancelled: <slug>") and a final marker are both useful information.

## Out of scope

- **Per-tool denylist for non-sleep gaming.** PR #20 already discussed this; if manual gaming (no sleep) becomes noisy again it's a separate, smaller spec.
- **`kuroboto report` CLI as an alternative relay** (Approach A in the design discussion). Approach B (stdout markers) was chosen because the daemon already owns the spawn — adding a CLI relay would mean a Bash call per report, polluting the audit log.
- **Streaming claude's full stdout to Telegram.** Considered and rejected — the whole point is to filter noise. The marker protocol is the explicit channel.
- **Replacing the final PR-summary notification** in `sleepFinish.ts`. The "✅ sleep done — PR: <url>" remains; the marker-based "summary" is supplementary, not a replacement.

## Test plan

**Unit:**
- `sleepReportRelay.test.ts` — line-buffered parser (chunked input, split lines, multiple markers per chunk, non-matches ignored, error handling).
- `notifyFilter.test.ts` — gaming-only / sleep-only / both / neither × Q&A-vs-not vs progress-marker matrix.
- `sleeping.test.ts` extension — spawn args, PLAN_INTRO content, PROMPT_OUTRO appended.

**Integration (`daemon.test.ts` extension):**
- POST `/v1/notify` with `gaming.active = true` and `message = "Claude needs your permission to use Bash"` → returns `{ ok: true, suppressed: true }`, no `sendNotification` called.
- POST `/v1/notify` with `gaming.active = true` and `message = "Claude is waiting for your input"` → handled as Q&A (existing behavior).
- POST `/v1/notify` with `sleeping.active = [<one>]` and `message = "[[KUROBOTO]] task 1 done"` → passes through (progress markers bypass the filter).

**Smoke (post-merge, manual):**
1. Start a sleep session that runs ≥3 tasks with commits. Telegram should receive ~3 `📍 task N done: …` markers + the existing start/done notifications. No "Claude needs permission" noise.
2. Run `kuroboto gaming on 5m` standalone (no sleep). Telegram should still go silent for non-Q&A notifications during the 5 minutes.
3. Confirm `--dangerously-skip-permissions` actually short-circuits the PreToolUse hook by tailing the daemon log during a sleep — no `permission` route hits should appear.

## Tasks

1. **J1**: `/v1/notify` filter + `notifyFilter.test.ts`. Independent; ships first.
2. **J2 + J3**: `sleeping.ts` changes — `--dangerously-skip-permissions` flag, line-buffered marker parser, PLAN_INTRO/PROMPT_OUTRO updates — and the matching tests (`sleepReportRelay.test.ts`, `sleeping.test.ts` extensions).
3. **Final**: full suite green (target ~415 tests after additions), manual smokes 1–3, single PR.
