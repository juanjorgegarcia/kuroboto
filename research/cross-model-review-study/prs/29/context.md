# Kuroboto — agent entrypoint

Read this first when entering the repo cold. It's the canonical pointer for any agent (Claude, Cursor, ChatGPT) or new collaborator.

## What this is

Standalone Node CLI that bridges Claude Code ↔ Telegram so the user can answer Claude's permission prompts, see notifications, and (planned) reply with free text — from their phone, while away from the desk.

**Audience:** the user (single-tenant, self-hosted). Each user runs their own daemon + their own bot via BotFather. No shared infrastructure.

## How to run it

`README.md` has the full quickstart. TL;DR:

```bash
npm install && npm run build && npm link
kuroboto init                       # one-time: bot setup, config, hooks
kuroboto start                      # daemon
kuroboto claude                     # Claude Code, hooks live
# or:
kuroboto ohayo                      # morning ritual: tmux+daemon+claude wired
```

## Where everything lives

| Path | Purpose |
|---|---|
| `README.md` | User-facing usage |
| `docs/design.md` | Full architecture spec, including v0.2 redesign in §12 (read before changing daemon internals) |
| `docs/specs/` | In-flight feature specs (one per file). Each has problem, solution, files, behavior, test plan, tasks |
| `docs/specs-backlog.md` | Future feature ideas not yet specced |
| `docs/workflows/spec-via-sleep.md` | The brainstorm → spec → kuroboto sleep → PR workflow used here |
| `src/daemon/` | HTTP daemon (loopback only), permission flow, sleep mode, allowlist match |
| `src/channels/telegram/` | Telegram channel implementation |
| `src/hooks/` | Claude Code hook handlers (one per hook event) |
| `src/cli/` | CLI subcommands |
| `test/unit/` and `test/integration/` | Vitest |

## Active work

Two specs are committed and pending dispatch via `kuroboto sleep` (the project's autonomous executor):

- `docs/specs/prompt-context.md` — Spec A: session/intent header on Telegram messages
- `docs/specs/prompt-freetext-qa.md` — Spec B: free-text Q&A via tmux inject (depends on Spec A merging first)

Future pinned: Telegram supergroup + topics (`docs/specs-backlog.md`).

## How features get built here

The standard loop is documented in `docs/workflows/spec-via-sleep.md`:

1. Manual usage surfaces a pain
2. `/superpowers:brainstorming` (or `/morpheus`) to produce a spec in `docs/specs/`
3. Commit spec to main
4. `kuroboto sleeping start --plan docs/specs/<name>.md` dispatches an autonomous Claude in a worktree → opens PR
5. Review (manual + `/code-review` skill)
6. Squash merge

Tiny fixes (typos, one-line bugs, doc tweaks) skip the spec and go direct to main.

## Conventions

- Spec format: see existing specs in `docs/specs/` for structure
- Commit style: `<type>(<scope>): <message>` (e.g., `feat(daemon): ...`, `docs(specs): ...`)
- PR style: squash merge, delete branch
- Tests: `npm test` (vitest); integration uses mocked filesystem and channels
- Auth: daemon binds to `127.0.0.1` and requires `X-Kuroboto-Token` header (token in `~/.config/kuroboto/config.json`)

## What to consult externally

- Telegram Bot API docs — when touching the channel layer
- Claude Code hook docs — when wiring new hook events
- `~/.claude/skills/morpheus/SKILL.md` — the user's brainstorm-to-sleep workflow skill
