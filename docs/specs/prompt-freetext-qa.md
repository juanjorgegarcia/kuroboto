# Bot prompt free-text Q&A (tmux inject)

> Status: planned for next PR (Spec B of "bot UX overhaul" pair)

## Problem

Today the daemon receives the Claude Code `Notification` hook (e.g. when Claude pauses for free-text input) and forwards a generic line like `[kuroboto] Claude Code precisa de atenção.` to Telegram. The user sees the alert but cannot answer from Telegram — they have to walk back to the desk to type into the Claude session.

The desired UX is: the question Claude asked is forwarded to Telegram, the user types a reply on the phone, and the daemon injects that reply into Claude's input via `tmux send-keys`.

This spec implements that path, scoped to interactive (tmux) sessions only — sleep mode (autonomous Claude as a child process) is out of scope.

## Solution

Pipeline:

```
Claude pauses for input
  └─ Claude Code Notification hook → POST /v1/notification (kuroboto daemon)
        ├─ isQAPrompt(payload.message)?      → no: existing notif path (no change)
        └─ yes (and inject.enabled):
              ├─ readLastAssistantText(transcript_path)         (from src/daemon/transcript.ts)
              ├─ pendingReplies.create({session_id, cwd, ...})  → { id, promise, expiresAt }
              ├─ channel.sendQuestion({ text: header + 💭, forceReply: true, button: "💬 Reply" })
              │     → returns { sentMessageId }; saved on pendingReply
              └─ awaits promise
                    └─ resolved by:
                         ├─ Telegram polling sees a message with reply_to_message.id == sentMessageId
                         │     ├─ pendingReplies.resolveBySentMessageId(id, replyText)
                         │     ├─ injectStrategy.inject(replyText)
                         │     │     ├─ ok    → audit 'qa-injected'; channel.send('✅ Reply injetada')
                         │     │     └─ err   → audit 'qa-inject-failed'; channel.send('❌ inject falhou: <err>\n\nSua reply foi:\n<text>')
                         │     └─ done
                         └─ replyTimeoutMs elapses → audit 'qa-timeout'; channel.send('⏱ Q&A expirou'); drop pendingReply
```

Detection (`isQAPrompt`): hardcoded set of known Notification messages, starting with `'Claude is waiting for your input'`. Anything else is treated as a regular notification (existing path, unchanged). Extension = add a string to the array.

Reply flow uses Telegram's `force_reply` reply markup: when the user taps **💬 Reply**, Telegram opens an input box with the bot's question quoted above. The user's reply carries `reply_to_message.message_id` matching the bot's outbound message — that's how the daemon knows which pending Q&A this reply belongs to. Multi-Q&A disambiguation is automatic (each pending Q&A is its own message).

## Files

**Create:**
- `src/inject/index.ts` — `interface InjectStrategy { inject(text: string): Promise<void> }`, `createInjectStrategy(config)`.
- `src/inject/tmux.ts` — `class TmuxInjectStrategy` running `tmux send-keys -t <session> -l "<text>"` then `tmux send-keys -t <session> Enter` (literal mode `-l` avoids reinterpretation of `$`, quotes, etc).
- `src/daemon/notificationDetect.ts` — `const QA_PATTERNS: readonly string[] = ['Claude is waiting for your input']`, `isQAPrompt(message)`.
- `src/daemon/pendingReplies.ts` — in-memory manager: `create()`, `resolveBySentMessageId()`, timeout cleanup. Mirror of `pending.ts` (existing) but keyed by Telegram `sentMessageId` instead of internal `requestId`.
- `src/daemon/transcript.ts` — **identical to Spec A**, code reproduced below verbatim. Both PRs land identical content; git's 3-way merge dedups.
- `test/unit/notificationDetect.test.ts`
- `test/unit/tmuxInject.test.ts`
- `test/unit/pendingReplies.test.ts`
- `test/unit/transcript.test.ts` — same cases as Spec A (also dedups).

**Modify:**
- `src/channels/Channel.ts` — extend interface:
  ```ts
  sendQuestion(req: QuestionRequest): Promise<{ sentMessageId: string }>;
  onFreeText(handler: (msg: { text: string; replyToMessageId?: string }) => void): void;
  ```
- `src/channels/telegram/TelegramChannel.ts` — implement `sendQuestion` (sets `reply_markup: { force_reply: true }`); polling recognizes `reply_to_message`, dispatches to handler.
- `src/daemon/routes.ts` — `/v1/notification`: branch on `isQAPrompt(message) && config.inject.enabled`; create pendingReply, call `channel.sendQuestion`, await resolution.
- `src/daemon/server.ts` — startup-time check: if `config.inject.enabled === true`, run `tmux -V` and `tmux has-session -t <inject.session>`; on either failure, refuse to start with a clear error message.
- `src/config/schema.ts` — `InjectConfig`: add `replyTimeoutMs: z.number().int().min(1000).default(7200000)` (default 2h).
- `src/cli/init.ts` — wizard offers tmux opt-in; if accepted, sets `inject.enabled = true`, prompts for `inject.session` (default `'claude'`), `replyTimeoutMs` stays default.
- `test/integration/daemon.test.ts` — Q&A flow cases.

## Shared module — `src/daemon/transcript.ts`

Identical to Spec A. Reproduced here verbatim so the two specs' agents produce byte-identical output and git merges cleanly.

```ts
import fsp from 'node:fs/promises';

interface TranscriptLine {
  role?: string;
  content?: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

async function readLines(path: string): Promise<TranscriptLine[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const out: TranscriptLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TranscriptLine);
    } catch {
      continue;
    }
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

export async function readFirstUserMessage(transcriptPath: string): Promise<string | null> {
  const lines = await readLines(transcriptPath);
  for (const l of lines) {
    if (l.role === 'user') {
      const t = extractText(l.content);
      if (t) return t;
    }
  }
  return null;
}

export async function readLastAssistantText(transcriptPath: string): Promise<string | null> {
  const lines = await readLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'assistant') {
      const t = extractText(lines[i].content);
      if (t) return t;
    }
  }
  return null;
}
```

## Message format

**Q&A prompt (outbound to Telegram):**

```
[<host> / <folder> / "<first user msg>"]
💭 <last assistant text>

❓ Claude tá esperando uma resposta. Toque em Reply pra responder.
```

The header is produced by Spec A's `formatNotification` (Spec B does not modify formatters; it consumes them). The 💭 line carries the actual question Claude asked (from `readLastAssistantText`). The footer line is added by Spec B's Q&A path so the user knows it's an interactive notif vs a passive one.

Inline button: `[💬 Reply]`. Reply markup includes `force_reply: true` so tapping the button (or just replying to the message) opens an input box with the question quoted.

**Inject success FYI:**
```
✅ Reply injetada
```

**Inject failure (fallback):**
```
❌ Inject falhou: <error>

Sua reply foi:
<text>
```
The user can then paste the text into the tmux session manually.

**Reply timeout:**
```
⏱ Q&A expirou (Claude pode ainda estar esperando)
```

## Behavior details

- **Detection is conservative.** Anything not in `QA_PATTERNS` falls through to the existing notification path, unchanged. No regression risk for non-QA notifications.
- **Inject is opt-in.** `inject.enabled = false` by default. The Q&A branch is skipped entirely when disabled, regardless of Notification message — falls through to existing notif path.
- **Startup validation is hard-fail.** If `inject.enabled = true` but tmux isn't available or the session doesn't exist, the daemon refuses to start with a clear error. Reason: silent runtime failures here are worse than failed startup; user is meant to set this up consciously.
- **Inject uses literal mode (`-l`).** `tmux send-keys -l "<text>"` writes the bytes directly without parsing key names. Then a separate `tmux send-keys Enter` submits. This preserves quotes, `$`, backticks, newlines, etc., in the user's reply.
- **Multiline replies:** the reply is sent as-is via `-l` (tmux's literal mode preserves embedded newlines), followed by a single trailing `tmux send-keys Enter` to submit. No splitting on `\n` in our code.
- **One pending Q&A per Notification.** The daemon doesn't dedupe across `session_id` — if Claude sends multiple Notifications quickly, each gets its own pending entry and Telegram message. User picks which to answer.
- **No Q&A in sleep mode.** The `/v1/notification` Q&A branch checks the sleep snapshot first and skips Q&A if the cwd matches an active sleep worktree (sleep is autonomous; if Claude pauses there, it's a stuck session — should fall through to plain notif so the user can investigate).

## Failure modes

| Failure | Behavior |
|---|---|
| `inject.enabled=true`, tmux not installed | daemon refuses startup with `tmux not found in PATH; either install tmux or set inject.enabled=false` |
| `inject.enabled=true`, tmux session doesn't exist | daemon refuses startup with `tmux session '<name>' not found; create it before starting kuroboto` |
| `tmux send-keys` returns non-zero at runtime (session died mid-flight) | audit `qa-inject-failed`; channel sends fallback message with the user's text (option A above) |
| `transcript_path` missing or unreadable | `readLastAssistantText` returns null; the 💭 line is omitted; Q&A still triggers (footer still asks user to reply) |
| Telegram polling drops connection | existing channel-error path (Q&A inherits, no special handling) |
| User never replies | `replyTimeoutMs` (default 2h) → audit `qa-timeout` + FYI message; pendingReply state dropped |

## Audit

New `source` values in `audit.jsonl`:

- `qa-pending` — Q&A prompt sent to Telegram, awaiting reply
- `qa-injected` — reply received and injected successfully
- `qa-inject-failed` — reply received but inject failed
- `qa-timeout` — no reply within `replyTimeoutMs`

Existing values unchanged.

## Out of scope (follow-ups, see `docs/specs-backlog.md`)

- Multi-Claude tmux mapping (per-cwd injection target).
- Telegram supergroup forum-mode threads (one topic per `session_id`) — orthogonal UX shift.
- PTY-based injection (drops the tmux dependency).
- Configurable `QA_PATTERNS` via config — wait until a real pattern shows up that's worth user-tunable behavior.
- Inject for sleep mode (would require child_process stdin write, different mechanism).

## Test plan

**Unit (`notificationDetect.test.ts`):**
- `isQAPrompt('Claude is waiting for your input')` → true
- `isQAPrompt('Task complete')` → false
- `isQAPrompt('')` → false
- `isQAPrompt(undefined)` → false (resilient)

**Unit (`tmuxInject.test.ts`):** (use a mocked `child_process.spawn`)
- `inject('hello')` → spawn called with `tmux send-keys -t <session> -l hello` then `tmux send-keys -t <session> Enter`
- `inject('he said "hi"')` → quotes preserved (mock captures argv unchanged)
- `inject('echo $HOME')` → `$HOME` not expanded (literal flag works)
- spawn exits non-zero → `inject` rejects with stderr in error

**Unit (`pendingReplies.test.ts`):**
- `create()` returns `{ id, promise }`; promise pending initially
- `resolveBySentMessageId(id, 'reply')` → promise resolves with 'reply'
- timeout fires → promise rejects, entry removed
- two pending entries don't interfere
- `resolveBySentMessageId('unknown')` → no-op (no throw)

**Unit (`transcript.test.ts`):** identical to Spec A.

**Integration (`daemon.test.ts`):**
- `inject.enabled=true` + Notification message `'Claude is waiting for your input'` + cwd with mock transcript → mock channel receives `sendQuestion` with `forceReply: true`, audit entry `qa-pending`
- Mock channel emits free-text reply matching the `sentMessageId` → mock `tmuxInject.inject` is called with the reply text, audit `qa-injected`, channel receives '✅ Reply injetada'
- Mock `tmuxInject.inject` rejects → channel receives '❌ inject falhou' with the user's text, audit `qa-inject-failed`
- Notification with non-QA message + `inject.enabled=true` → existing notif path (no `sendQuestion`)
- Notification with QA message + `inject.enabled=false` → existing notif path (no `sendQuestion`)
- Notification with QA message + cwd is in sleep snapshot → existing notif path (no Q&A in sleep)

**Integration (startup, `daemon.test.ts` or new `startup.test.ts`):**
- `inject.enabled=true` + mock `tmux -V` returns non-zero → daemon throws with clear error
- `inject.enabled=true` + mock `tmux has-session` returns non-zero → daemon throws with session-not-found error
- `inject.enabled=false` → no tmux check (passes regardless of tmux availability)

**Smoke (post-merge):**
1. `tmux new -s claude` in a terminal
2. Inside, run `claude code` and start any task that will pause for input ("escolha entre A e B")
3. In another terminal, `kuroboto start` (with `inject.enabled=true`, `inject.session='claude'`)
4. Wait for the Telegram notif with the question + 💬 Reply button
5. Tap Reply, type `A`, send
6. Verify in the tmux pane that `A` appeared and Enter was pressed
7. Verify Telegram receives `✅ Reply injetada`

## Tasks

1. **M1**: Create `src/daemon/transcript.ts` (canonical), `src/daemon/notificationDetect.ts`, `src/daemon/pendingReplies.ts`, `src/inject/{index,tmux}.ts`. Unit tests for all.
2. **M2**: Extend `Channel` interface, implement in `TelegramChannel`. Wire `/v1/notification` Q&A branch. Add startup tmux validation. Add `replyTimeoutMs` to schema + init wizard.
3. **M3**: Integration tests + manual smoke. PR.
