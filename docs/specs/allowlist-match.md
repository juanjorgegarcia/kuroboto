# Daemon-side allowlist match

> Status: planned for next PR

## Problem

The "🔓 Allow & remember" button persists matchers to
`<cwd>/.claude/settings.local.json` (`permissions.allow[]`). But the kuroboto
**daemon** never reads that file before deciding whether to prompt — it always
sends `/v1/permission` requests for `Bash`/`Edit`/`Write` to Telegram in away
mode.

Concretely: you click 🔓 on a `uv run X` prompt → `Bash(uv:*)` is saved →
**but the very next `uv run Y` still pings your phone**. The matcher only takes
effect on Claude's NEXT session (when it reloads `settings.local.json`).

The intended UX is "remember = next time it just runs." This spec closes the gap.

## Solution

Before sending a permission prompt to Telegram, the daemon reads
`<payload.cwd>/.claude/settings.local.json` and checks whether any pattern in
`permissions.allow[]` matches the incoming tool call. If yes → return `allow`
without bothering the user.

```
/v1/permission flow (after this change):
  if gaming.active && tool ∉ gamingAlwaysAsk         → allow (gaming)
  if mode === 'here' || tool ∉ permissionMatchers    → ask
  if cwd has matching pattern in settings.local.json → allow (allowlist)   ← NEW
  else                                                → Telegram prompt
```

The deny list (`permissions.deny[]`) is **also** consulted — a deny-list match
short-circuits to `deny` directly, no Telegram round-trip.

## Pattern grammar (subset of Claude Code's)

We implement the patterns most commonly seen in real `settings.local.json`
files. Anything we don't recognize falls through (= prompt as before).

| Pattern | Meaning | Match rule |
|---|---|---|
| `Bash` | any Bash call | `tool === 'Bash'` |
| `Bash(npm:*)` | command first token = `npm` | `Bash` and `command.split(/\s+/)[0] === 'npm'` |
| `Bash(npm install:*)` | first two tokens = `npm install` | `Bash` and tokens [0,1] match |
| `Bash(npm install foo)` | exact command (no `:*`) | `Bash` and `command === 'npm install foo'` |
| `Edit` / `Write` / `Read` | any call | tool name match only |
| `Edit(/path/to/file.ts)` | exact file path | tool match + `file_path === '/path/to/file.ts'` |
| `Edit(/src/**)` | glob over file_path | tool match + `minimatch(file_path, '/src/**')` |
| `Read(//tmp/**)` | glob (note: Claude Code uses double-slash to mean "absolute") | tool match + minimatch |
| anything else | unrecognized → no match | falls through |

## Files

**Create:**
- `src/daemon/allowlistMatch.ts` — `loadAllowlist(cwd)`, `matchPattern(toolName, toolInput, pattern): boolean`, `matchAny(toolName, toolInput, patterns)`
- `test/unit/allowlistMatch.test.ts` — pattern matching cases (Bash prefix, exact, Edit glob, Read glob, mismatched tool, malformed)

**Modify:**
- `src/daemon/routes.ts` — in `/v1/permission`, before falling into the away-mode prompt path, consult the allowlist (allow first, then deny). Audit with `source: 'allowlist-allow'` / `'allowlist-deny'`.
- `package.json` — add `minimatch` dep (already very common, ~10KB).
- `test/integration/daemon.test.ts` — new tests: away mode + matching pattern → instant allow, no `sentPrompts`. Same for deny pattern.

## Behavior details

- **Lookup is per-request, not cached**: each `/v1/permission` reads the file
  fresh. Cost is one fs read (KB-sized JSON, OS-cached). Avoids stale state if
  another process (Claude itself, or a manual edit) updates the file mid-session.
- **Read failure is non-fatal**: if the file doesn't exist, can't be parsed, or
  has no `permissions.allow`, we fall through to the prompt path (existing
  behavior). Logged at debug level.
- **Order**: `permissions.deny[]` is checked first (security-first), then
  `permissions.allow[]`. If both match (rare but possible), deny wins.
- **`cwd` missing from payload**: skip the lookup, fall through. Same as today
  for `Allow & remember` persistence.

## Audit

New `source` values in `audit.jsonl`:

- `allowlist-allow` — short-circuited to allow because a `permissions.allow[]`
  pattern matched
- `allowlist-deny` — short-circuited to deny

Existing values (`telegram`, `gaming`, `timeout`, `channel-error`) keep their
meanings.

## Out of scope (follow-ups)

- Full Claude Code pattern grammar (e.g., `WebFetch(domain:example.com)`,
  `--allowedTools` precedence, `*.allow` from `~/.claude/settings.json`
  hierarchy). We only read project-local `<cwd>/.claude/settings.local.json`.
- Caching the parsed file with mtime invalidation (premature optimization;
  re-read per request is fine at our scale).
- A `kuroboto allowlist add <pattern>` CLI for manual matchers (today the user
  uses 🔓 Allow & remember or edits the JSON directly).

## Test plan

**Unit (`allowlistMatch.test.ts`):**
- `matchPattern('Bash', { command: 'npm install lodash' }, 'Bash(npm:*)')` → true
- `matchPattern('Bash', { command: 'npm install lodash' }, 'Bash(npm install:*)')` → true
- `matchPattern('Bash', { command: 'npm test' }, 'Bash(npm install:*)')` → false
- `matchPattern('Bash', { command: 'npm install foo' }, 'Bash(npm install foo)')` → true (exact)
- `matchPattern('Bash', { command: 'npm install foo bar' }, 'Bash(npm install foo)')` → false (exact mismatch)
- `matchPattern('Edit', { file_path: '/src/a.ts' }, 'Edit(/src/**)')` → true
- `matchPattern('Read', { file_path: '/tmp/x' }, 'Read(//tmp/**)')` → true
- `matchPattern('WebFetch', { url: 'x' }, 'WebFetch(domain:example.com)')` → false (out-of-scope grammar)
- `matchPattern('Edit', { file_path: '/x' }, 'Bash(npm:*)')` → false (tool mismatch)
- `loadAllowlist('/nonexistent')` → `{ allow: [], deny: [] }` (no throw)
- `loadAllowlist(<dir-with-malformed-json>)` → `{ allow: [], deny: [] }`

**Integration (`daemon.test.ts`):**
- away mode + `Bash(echo:*)` in `<tmpdir>/.claude/settings.local.json` + tool `Bash echo hi` → `decision: 'allow'`, no Telegram prompt sent, audit entry with `source: 'allowlist-allow'`
- away mode + `Bash(rm:*)` in deny → `decision: 'deny'`, no prompt, `source: 'allowlist-deny'`
- away mode + tool not matching any pattern → falls through to existing prompt flow (sentPrompts.length === 1)
- away mode + cwd missing from payload → falls through

**Smoke:**
- After merge, in `/tmp/kbsleep`, click 🔓 Allow & remember on a `Bash` prompt; immediately re-trigger the same Bash command. Expected: no second Telegram prompt, just runs.

## Tasks (subagent-driven, 3 steps)

1. **M1**: Spec done (this doc) + create `allowlistMatch.ts` + unit tests + add minimatch dep.
2. **M2**: Wire into `routes.ts` `/v1/permission`. Add integration tests. Audit entries.
3. **M3**: PR + auto-review + smoke validation.
