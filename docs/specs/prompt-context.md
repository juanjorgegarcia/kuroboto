# Bot prompt context header (session + intent)

> Status: planned for next PR (Spec A of "bot UX overhaul" pair)

## Problem

When a Telegram permission prompt arrives — `[kuroboto] Pode rodar?\n\nBash: rm -rf /tmp/foo` — two questions are hard to answer fast:

1. **Which session is asking?** With multiple Claude sessions running in parallel (multiple machines, multiple repos, or the same repo opened twice), the lone `[folder]` tag is ambiguous. UUIDs would resolve it but are unreadable for humans.
2. **Why is Claude trying to run this?** The raw `Bash: <cmd>` line shows what but never why. To decide quickly, the user wants the assistant's last reasoning ("I'll clean up temp files before deploy") right next to the command.

The fix is to enrich the prompt and notification messages with session-identifying context and the assistant's intent line — both extracted from data the daemon already has access to.

## Solution

Two new lines on every Telegram prompt/notification:

**Header line** identifies the session:
- Interactive: `[<hostname> / <folder> / "<first user message>"]`
- Sleep mode: `[<hostname> / 💤 <slug-without-random-suffix>]`

**Intent line** prefixes Claude's reasoning:
- `💭 <last assistant text before the tool_use, truncated>`

Resulting permission prompt:

```
[win-juan / kuroboto / "vamos melhorar a UX do bot"]
💭 Vou limpar os arquivos temporários antes do deploy

Pode rodar?
Bash: rm -rf /tmp/foo
```

Resulting notification (Claude awaiting attention):

```
[win-juan / kuroboto / "vamos melhorar a UX do bot"]
💭 Aguardando confirmação antes de rodar a migração

Claude Code precisa de atenção.
```

## Pattern grammar / data sources

| Field | Source | Fallback |
|---|---|---|
| `<hostname>` | `os.hostname()` cached at daemon startup | n/a (always available) |
| `<folder>` | last segment of `payload.cwd` | omit if `cwd` missing |
| `<first user message>` | first `user`-role line in `transcript_path` JSONL, text content concatenated, truncated to 60 chars | omit the `"..."` segment if file/parse fails |
| `<sleep slug>` | `ctx.state.sleeping.snapshot()` lookup by `cwd`; strip the random `-xxxxxx` suffix from the worktree slug for display | n/a (only used when sleep match found) |
| `<last assistant text>` | last `assistant`-role message in transcript; concat its `text` content blocks; if empty (only tool_use blocks), recurse to previous `assistant` message; truncate to 200 chars | omit `💭 ...` line entirely |

## Files

**Create:**
- `src/daemon/transcript.ts` — `readFirstUserMessage(path)`, `readLastAssistantText(path)`. Both swallow errors and return `null`.
- `test/unit/transcript.test.ts` — JSONL parsing edge cases.
- `test/unit/promptFormat.test.ts` — formatter scenarios (full data, missing pieces, sleep vs interactive).

**Modify:**
- `src/daemon/routes.ts` — `formatPermissionPrompt`, `formatNotification`: take new helpers + sleep snapshot + hostname. The gaming FYI path (`🎮 ${formatPermissionPrompt(payload)}`) auto-inherits.
- `src/daemon/server.ts` — pass `os.hostname()` into `DaemonContext` once at startup.
- `src/daemon/lifecycle.ts` (or wherever `DaemonContext` is built) — add `hostname: string` field.
- `src/core/types.ts` — formal `UserPromptSubmitPayload` interface (Claude Code already sends this; the daemon's heartbeat hook just doesn't read fields today). No behavior change beyond type hygiene.
- `test/integration/daemon.test.ts` — 2 cases: prompt formatted with mock transcript file (interactive), and prompt formatted in sleep mode (💤 prefix).

## Shared module — `src/daemon/transcript.ts`

This file is consumed read-only by Spec B (free-text Q&A). To avoid merge conflicts when both specs run in parallel sleep agents, **the implementation below is canonical**. Both specs reproduce this exact code; if both PRs land before merge, git's 3-way merge dedups identical content.

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

## Behavior details

- **Read-on-demand, no cache:** each PreToolUse/Notification reads the transcript file. Same approach as `loadAllowlist` in the allowlist-match feature. JSONL is small, OS-cached, and freshness matters more than µs.
- **Order of resolution:** sleep detection runs first; if sleep, skip first-user-message read (it would just be the daemon's `PLAN_INTRO` boilerplate). For interactive mode, do both reads in parallel.
- **Hostname is per-machine, not per-config:** no override option. Multi-machine workflows (Tailscale + remote sessions) get the right name automatically.
- **Truncation:** uses the existing `truncate(s, max)` helper from `routes.ts` (`s.slice(0, max - 1) + '…'`). Limits: 60 for first-user-message, 200 for assistant-text, 200 for tool summary (unchanged).
- **No new state:** sleep snapshot is already in `DaemonContext`; transcript reads are stateless.

## Out of scope (follow-ups, see `docs/specs-backlog.md`)

- Telegram supergroup forum-mode threads (one topic per `session_id`) — bigger UX shift, separate spec.
- Caching parsed transcript with mtime invalidation — premature optimization at our scale.
- User-named session slugs (env var override) — wait until the auto-extracted "first user message" proves insufficient.
- Free-text Q&A and inject — covered by Spec B (`prompt-freetext-qa.md`).

## Test plan

**Unit (`transcript.test.ts`):**
- `readFirstUserMessage` returns text from a normal user-led JSONL
- `readFirstUserMessage` skips system-role lines and returns first `user`
- `readFirstUserMessage` on missing file → `null`
- `readFirstUserMessage` with malformed JSONL lines mixed in → returns first valid `user`, ignores junk
- `readLastAssistantText` returns text from latest assistant message containing text + tool_use blocks
- `readLastAssistantText` falls back to previous assistant when latest has only tool_use blocks
- `readLastAssistantText` on file with no assistant → `null`
- `readLastAssistantText` on empty file → `null`

**Unit (`promptFormat.test.ts`):**
- Interactive, all data present → `[host / folder / "..."] \n💭 ...\n\nPode rodar?\nBash: ...`
- Interactive, no transcript → `[host / folder]\n\nPode rodar?\nBash: ...`
- Interactive, no cwd → `[host]\n\nPode rodar?\nBash: ...`
- Sleep mode → `[host / 💤 slug-no-suffix]\n💭 ...\n\nPode rodar?\nBash: ...`
- First-user-message > 60 chars → truncated with `…`
- Assistant-text > 200 chars → truncated with `…`

**Integration (`daemon.test.ts`):**
- Away mode + tmpdir with mock `transcript.jsonl` containing one user msg "fix the bot UX" and one assistant msg "I'll start by..." → `sentPrompts[0].text` contains `"fix the bot UX"` in header and `💭 I'll start by...` line
- Sleep mode active → prompt formatted with `💤 <slug-no-suffix>`, no `"first user msg"` segment

**Smoke (post-merge):**
- Trigger an interactive permission prompt; verify Telegram shows hostname + folder + first prompt + 💭 intent line
- Run `kuroboto sleep <repo> --plan <some.md>` and trigger a permission prompt inside the worktree; verify Telegram shows `💤 <slug>` and no first-prompt segment

## Tasks

1. **M1**: Create `src/daemon/transcript.ts` (canonical code above) + unit tests.
2. **M2**: Wire `hostname` into `DaemonContext`. Update `formatPermissionPrompt` and `formatNotification`. Add unit tests for formatter.
3. **M3**: Add integration tests. Manual smoke. PR.
