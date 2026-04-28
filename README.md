# Kuroboto

Respond to Claude Code prompts from your phone via chat (Telegram first).

**Status:** v0.1 in development. See [design spec](docs/design.md) for the full architecture (including the v0.2 redesign in §12).

## Quickstart (post-build)

```bash
npm install
npm run build
npm link            # exposes `kuroboto` globally

kuroboto init       # wizard: Telegram bot setup + writes config + installs Claude Code hooks
kuroboto start --detach
kuroboto claude     # opens Claude Code with daemon running and hooks active
```

## Subcommands

| Command | Purpose |
|---|---|
| `kuroboto init` | Interactive wizard: BotFather flow, captures token + chat_id, writes `~/.config/kuroboto/config.json`, merges hooks into `~/.claude/settings.json` |
| `kuroboto start [--detach]` | Spawn the daemon |
| `kuroboto stop` | SIGTERM the daemon, drains pending requests |
| `kuroboto status` | Daemon health, channel state, hooks installed, last activity |
| `kuroboto claude [...args]` | Ensures daemon is up + hooks installed, then execs `claude` |
| `kuroboto hook <type>` | Internal — invoked by Claude Code hooks (don't call directly) |

## Layers

- **Layer 1 — Notifications** (fire-and-forget): pushes Telegram message when Claude Code is waiting
- **Layer 2 — Permissions** (blocking): Claude prompts → Telegram inline keyboard (✅ Allow / ❌ Deny / 📝 Reply) → response routed back as the hook's stdout decision
- **Layer 3 — Free-text injection** (v0.2): tmux send-keys for arbitrary input

## Architecture (high-level)

```
Claude Code <─stdin/stdout─> kuroboto hook <─HTTP loopback─> kuroboto daemon <─long-poll─> Telegram
```

The daemon runs locally, listens on `127.0.0.1` only, requires an auth token, and never logs secrets. Each user runs their own bot — no shared infrastructure.

## License

MIT
