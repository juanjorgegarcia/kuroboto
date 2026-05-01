# Competitive landscape (2026-04-30)

> Snapshot of the autonomous coding agent / cloud PR pipeline space vs kuroboto.
> Live document — re-fetch first-party docs before any pivot decision; LLM
> training cutoffs lag by 6+ months and this space ships weekly.

## Sources

Authoritative — verified via WebFetch on 2026-04-30:

- [code.claude.com/docs/llms.txt](https://code.claude.com/docs/llms.txt) — Anthropic Claude Code feature index
- [code.claude.com/docs/en/ultrareview.md](https://code.claude.com/docs/en/ultrareview.md) — multi-agent cloud review
- [code.claude.com/docs/en/channels.md](https://code.claude.com/docs/en/channels.md) — Telegram/Discord/iMessage MCP
- [code.claude.com/docs/en/remote-control.md](https://code.claude.com/docs/en/remote-control.md) — mobile session control
- [code.claude.com/docs/en/routines.md](https://code.claude.com/docs/en/routines.md) — scheduled cloud agents
- [code.claude.com/docs/en/ultraplan.md](https://code.claude.com/docs/en/ultraplan.md) — cloud planning

Background (LLM-research, less reliable, training cutoff Aug/2025) — session
`2656940e-a427-42e0-86ce-07fdafb84029.jsonl` line 203 (29-Apr-2026 octo:research
probe `probe-1777506136-5`). Extracted excerpt:
`research/cross-model-review-study/extracted-table-0.md`. Skips features
shipped after Aug/2025 (notably the Anthropic suite below) — treat as
historical context, not current state.

## What changed: Anthropic shipped most of kuroboto's surface

The first-generation kuroboto pitch (Telegram trigger + local autonomy +
gaming mode + spec-driven PR) assumed a market gap. Between Aug/2025 and
Apr/2026 Anthropic closed most of it via the Claude Code suite:

| kuroboto feature | Anthropic equivalent | Status |
|---|---|---|
| Telegram bridge (Spec F) | **Channels** — MCP plugins for Telegram/Discord/iMessage push into a running session | Commodity |
| Mobile trigger via Telegram | **Remote Control** — continue local session from phone/tablet/browser | Commodity |
| Sleep mode (autonomous spec → PR) | **Routines** — schedule, API trigger, GitHub-event reactions, cloud-managed | Commodity (cloud) |
| Auto code-review on PR open | **/autofix-pr** (Week 15) — auto-fix PRs in cloud | Commodity |
| Plan-driven workflow (`--plan`) | **Ultraplan** — draft plan on web, execute remotely or in terminal | Commodity |
| Multi-agent code review | **Ultrareview** — fleet of reviewer agents in cloud sandbox, verified findings | Commodity (mono-lineage) |
| Multi-worktree parallel sleeps (Spec D) | **Desktop App** — parallel sessions with Git isolation | Commodity |
| Gaming mode (auto-allow tool use) | **Sandboxing** — FS + network isolation for autonomous bash | Commodity |

OpenAI also shipped Codex Cloud (scheduled tasks, cloud sandbox, PR creation)
covering a similar surface from the GPT side.

## What's left of the moat

Map of the original 4-pillar pitch against today:

### 1. Local-first sovereignty — partial moat (privacy nicho)

Anthropic's Sandbox/Web run code in their cloud, on their infrastructure,
under their terms. Kuroboto runs in your filesystem, with your `gh` auth, on
your machine. This still matters for:

- Engineers under data-residency / compliance constraints (e.g. Zero Data
  Retention orgs — Ultrareview is **explicitly unavailable** to ZDR orgs)
- Repos that don't fit cloud bundling limits
- Air-gapped or offline scenarios via ollama

It is no longer a *technical* differentiator (Anthropic does the same job
better with cloud horsepower); it is a *positioning* differentiator for a
specific privacy/sovereignty buyer.

### 2. Agent-agnostic (multi-LLM via OAuth CLIs) — real moat

Anthropic's suite is Claude-only. OpenAI Codex Cloud is GPT-only. Neither lets
you mix lineages.

Kuroboto's Spec R smoke (2026-04-30, M1) proved you can plug claude + codex +
gemini + copilot via OAuth CLIs (subscription quota, $0 marginal cost) plus
ollama for local controls — all behind a unified harness. **No competitor
offers this today.**

### 3. Cross-lineage review as quality moat — **aspirational, Spec R is the bet**

Ultrareview is multi-agent (a "fleet of reviewer agents") but **mono-lineage**:
- Runs entirely on "Claude Code on the web infrastructure"
- No mention of non-Claude models in the docs
- Explicitly unavailable on Bedrock / Vertex / Foundry (Claude.ai-only auth)
- All reviewers share the same training corpus → same blind spots

The Spec R hypothesis: cross-lineage review captures findings that any
mono-lineage fleet misses (≥20% unique P0/P1 vs Claude-only baseline). If H1
holds, this is the only *technical* differentiator left where kuroboto can
genuinely outperform Anthropic's commodity offering on quality, not just
positioning. If H0, kuroboto is "Anthropic suite with bring-your-own-LLM" —
narrow privacy/sovereignty play only.

### 4. Free tier via Telegram — go-to-market, not moat

Distribution channel for dogfood and onboarding, not a defensible technical
property. Any competitor can match it.

## Updated competitive matrix

| Capability | Anthropic Suite | OpenAI Codex Cloud | OpenHands | Plandex | **kuroboto** |
|---|:---:|:---:|:---:|:---:|:---:|
| Local-first (your filesystem, your auth) | ❌ | ❌ | Partial | ✅ | ✅ |
| Agent-agnostic (mix LLM lineages) | ❌ Claude-only | ❌ GPT-only | Partial | ❌ | ✅ |
| Cross-lineage review | ❌ Ultrareview mono-Claude | ❌ | ❌ | ❌ | ⏳ Spec R |
| Telegram trigger | ✅ Channels | ❌ | ❌ | ❌ | ✅ |
| Mobile trigger (any device) | ✅ Remote Control | ChatGPT app | Web | ❌ | ✅ |
| Auto PR fix | ✅ /autofix-pr | ✅ | ✅ | ❌ | ✅ |
| Scheduled / event triggers | ✅ Routines | ✅ Cloud Tasks | Partial | ❌ | Partial |
| Plan-driven autonomous | ✅ Ultraplan | ✅ | ❌ | ✅ | ✅ |
| Multi-agent code review | ✅ Ultrareview | ❌ | ❌ | ❌ | ⏳ Spec R |
| Sandboxing / auto-allow | ✅ Sandbox | ✅ | ✅ Docker | ❌ | ✅ Gaming |
| Multi-worktree parallel | ✅ Desktop | ✅ | ✅ | ❌ | ✅ Spec D |
| Zero infra cost (no SaaS sub) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Available to ZDR orgs | ❌ Ultrareview blocks | ? | ✅ | ✅ | ✅ |

Cells marked ⏳ Spec R are kuroboto's bet, not validated yet.

## Decision rule for the roadmap

Three live scenarios for the next quarter:

- **Spec R H1 holds (≥20% unique P0/P1 cross-lineage)**: pivot to "cross-LLM
  autonomous PR pipeline" as the headline. The pitch becomes: kuroboto finds
  bugs Anthropic Ultrareview misses, by design, because Anthropic can't ship
  cross-lineage. Spec Q' for the implementation.

- **Spec R H0 (no statistical lineage advantage)**: drop the cross-lineage
  angle. Reposition as "self-hosted Anthropic alternative for ZDR / data-
  sovereignty buyers". Smaller market but defensible.

- **Anthropic ships cross-lineage Ultrareview before Spec R completes**:
  Most existential risk. Watch the changelog weekly. If they add it, the
  technical moat collapses entirely and the only remaining play is privacy/
  sovereignty positioning.

## Re-validation cadence

Re-fetch `code.claude.com/docs/llms.txt` and OpenAI Codex changelogs at least
every 2 weeks. Update this doc whenever a competitor ships into a column
where kuroboto previously had a ✅. The 2026-Q2 release cycle is fast — this
doc rots in days, not months.
