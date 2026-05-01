# Cross-model PR review delta study

> Status: planned. Spec R. **One-shot research artifact**, not a kuroboto product
> feature. Uses Promptfoo as the dispatch+caching+comparison harness over a curated
> corpus of merged PRs from this repo, with 8 LLM providers across 7 lineages,
> producing a reproducible dataset and a delta-report. Output decides whether
> kuroboto pivots to "cross-LLM autonomous PR pipeline" as the headline feature.

## Problem

Anthropic shipped a near-complete coverage of kuroboto's surface between
Aug/2025 and Apr/2026 (verified via `code.claude.com/docs/llms.txt` on
2026-04-30, see `docs/competitive-landscape.md` for the full mapping):

- **`/autofix-pr`** (Week 15) — cloud-side PR fix iteration
- **Routines** — scheduled / event-triggered cloud agents
- **Channels** — MCP plugins for Telegram/Discord/iMessage
- **Remote Control** — mobile session trigger
- **Ultraplan** — cloud plan drafting and execution
- **Ultrareview** — multi-agent cloud code review with verified findings
- **Sandboxing**, **Desktop App parallel sessions**, **Web interface**

**Ultrareview is the most direct competitor** — multi-agent fleet of
reviewers in a cloud sandbox, "every reported finding is independently
reproduced and verified". Pricing $5–20 per run after 3 free runs (Pro/Max,
expiring 2026-05-05). Critical detail per the docs: it runs entirely on
"Claude Code on the web infrastructure", is unavailable on Bedrock / Vertex /
Foundry, and never mentions non-Claude models. **It is mono-lineage by
design** — every reviewer in the fleet shares the same Anthropic training
corpus and therefore the same blind spots.

The remaining differentiation hypothesis: a kuroboto-style loop that uses
**different lineages for the reviewer vs the implementer** catches findings
that any mono-lineage fleet (Claude-on-Claude, GPT-on-GPT) systematically
misses. Lineage diversity as a quality moat that Anthropic / OpenAI cannot
ship from inside their own walled gardens.

This hypothesis is unvalidated. Pivoting kuroboto's roadmap on it without
empirical evidence is a costly bet. A focused study can produce data in
hours and eliminate the guesswork.

## Hypothesis

**H1**: For a fixed PR diff, models from distinct training lineages (Anthropic,
Google, OpenAI, DeepSeek, Alibaba, Meta) produce review findings whose union
is **strictly larger and qualitatively distinct** from any single-lineage
review (e.g., Claude-only). Specifically: cross-lineage adds ≥20% unique
P0/P1 findings vs Claude-sonnet baseline.

**H0 (null)**: Cross-lineage variance is no greater than within-lineage
variance (same model run N times). Single-model is sufficient and lineage
diversity is decorative.

If H1 holds → pivot kuroboto to cross-LLM PR pipeline (moat real).
If H0 holds → drop the cross-model angle, keep current trajectory.

## Method

### Corpus

4 merged PRs from this repository, chosen for rich review history and varied
scope:

| PR | Theme | Why |
|---|---|---|
| #29 | Spec G watchdog (1.7K LOC, 9 review findings) | Deepest existing review baseline |
| #30 | Spec G fixes (review-driven, 5 findings) | Tests "review-of-review" loop |
| #21 | CLI improvements bundle | Multiple files, mixed feature scope |
| #19 | CLI tests | Test-only PR, different category surface |

For each PR we capture:
- The full diff (`gh pr diff <num>`)
- The linked spec under `docs/specs/` (if any)
- `AGENTS.md` snapshot at merge time (project conventions baseline)

### Providers

8 providers across 7 lineages. Same review prompt for all, sourced verbatim
from `.github/workflows/claude-code-review.yml` so the comparison is
apples-to-apples with the production auto-review.

| Provider | Lineage | Notes |
|---|---|---|
| `claude-sonnet-4.6` | Anthropic | baseline (matches production auto-review) |
| `claude-opus-4.7` | Anthropic (larger) | controls size vs lineage |
| `gemini-3-pro` | Google | |
| `gpt-5` (Codex) | OpenAI | |
| `copilot` | wrapped/mixed | $0 marginal cost — high-N control |
| `openrouter:deepseek-r1` | DeepSeek (China) | |
| `opencode-go:qwen2.5-coder` | Alibaba (China, coding-tuned) | |
| `ollama:qwen2.5-coder:7b` + `ollama:llama3.1:8b` | local open-weight (Alibaba/Meta) | $0, 7-8B param scale |

**Size confound caveat**: cloud models (Claude/GPT/Gemini) are 100B+ params;
Ollama models are 7-8B. Analysis bins findings into "cloud-tier" and
"local-tier" before drawing lineage conclusions.

### Sampling

- N=3 runs per (PR, paid provider) → captures stochasticity at reasonable cost
- N=10 runs for `copilot` and Ollama models (free) → tight variance baseline

Total per PR: 3 paid × 5 + 10 × 3 free = 45 reviews. Across 4 PRs: 180
reviews.

### Output schema

Each review is prompted to return strict JSON:

```jsonc
{
  "findings": [
    {
      "file": "src/foo.ts",
      "line": 123,
      "severity": "P0" | "P1" | "P2",
      "category": "bug" | "security" | "spec" | "convention" | "silent-failure" | "performance" | "test-gap",
      "summary": "<single-sentence description>"
    }
  ],
  "verdict": "LGTM" | "comments" | "request changes"
}
```

Promptfoo's JSON schema assertion enforces shape; any review failing to
return valid JSON is recorded as `parse-failed` and excluded from the
overlap analysis (but kept in raw data).

### Analysis pipeline

Custom TypeScript script `analyze.ts` reads Promptfoo's JSON output and
computes:

1. **Per-provider stats**: total findings, severity distribution, category
   distribution.
2. **Within-provider variance** (across N runs): mean ± std findings count;
   Jaccard similarity between runs of same provider.
3. **Pairwise overlap matrix** (between providers): Jaccard on (file, line ±
   3, category). Two findings from different providers are "matched" if they
   reference within-3-lines of the same file with the same category.
4. **Unique-to-provider** count: findings flagged only by one provider, no
   matching peer.
5. **Aggregated lineage delta**: union of all-provider findings vs union of
   Anthropic-only findings. Report % uplift overall, and split by severity
   (P0/P1/P2).
6. **Statistical significance**: bootstrap CI on the "unique findings per
   provider" metric, comparing cross-lineage union vs single-lineage.

### Reporting

Output: `research/cross-model-review-study/results/delta-report.md`.

Sections:
- TL;DR verdict (H1 supported / H0 supported)
- Per-PR breakdown (findings table + overlap matrix per PR)
- Aggregate stats with confidence intervals
- Qualitative examples (cite 5-10 findings unique to non-Claude that look
  important + 5-10 false positives unique to non-Claude)
- Methodology + reproducibility instructions
- Caveats: small corpus (n=4), no human ground-truth labels, size confound

## Files

**Create:**
- `docs/specs/cross-model-review-delta-study.md` — this file.
- `research/cross-model-review-study/promptfooconfig.yaml` — 8 providers,
  prompt template, JSON schema assertion, repeats per provider.
- `research/cross-model-review-study/prs/<num>/diff.patch` — captured diff
  per PR.
- `research/cross-model-review-study/prs/<num>/spec.md` — captured spec per
  PR (if applicable).
- `research/cross-model-review-study/prs/<num>/context.md` — `AGENTS.md`
  snapshot.
- `research/cross-model-review-study/analyze.ts` — pairwise overlap + stats.
- `research/cross-model-review-study/README.md` — methodology + how to
  reproduce + how to add a provider in v2.
- `research/cross-model-review-study/results/.gitignore` — exclude raw
  cache, commit only `delta-report.md` + `findings.json` (the digest).

**Modify:** none. Pure additive research artifact.

## Reproducibility

Anyone with the same provider keys can:

1. `cd research/cross-model-review-study`
2. `npm install` (promptfoo + minimal deps for analyze.ts)
3. `promptfoo eval` (uses cached responses where available)
4. `npx tsx analyze.ts` → regenerates `delta-report.md`

Cache key includes prompt hash + provider config hash + input hash.
Re-running with the same setup is deterministic for cached entries; only
new provider configs cost tokens.

## Out of scope (v1)

- **Human ground-truth labeling**: would let us compute precision/recall
  per provider. Future v2.
- **More providers**: MiniMax, GLM, Kimi, Mistral. Add when v1 results
  motivate finer cuts.
- **More PRs**: 10+ corpus would tighten CIs. Add when v1 results show a
  promising-but-noisy effect that more data would clarify.
- **Cost optimization**: prompt-cache, batch APIs. v1 is research, cost
  control is v2.
- **Open dataset publication**: release the corpus + tool externally. v2,
  contingent on v1 producing publishable signal.

## Decision rule

- **H1 supported (≥20% unique P0/P1 from cross-lineage union vs
  Claude-only baseline, p<0.05 via bootstrap)** → pivot kuroboto roadmap
  to cross-LLM PR pipeline, write Spec Q' for the implementation. The pitch
  becomes "finds bugs Ultrareview misses by design" — Anthropic structurally
  cannot ship this from inside their own infrastructure.
- **H1 partially supported (10-20% uplift, mixed severity)** → keep
  cross-LLM as a configurable feature, not headline; reposition primary
  pitch around privacy / sovereignty (ZDR-friendly, since Ultrareview is
  explicitly blocked for ZDR orgs).
- **H0 not rejected (<10% unique findings, no statistical significance)** →
  drop the cross-model angle. The remaining moat reduces to "self-hosted
  Anthropic alternative for data-sovereignty buyers" — smaller market but
  defensible. See `docs/competitive-landscape.md` for the positioning.

## Existential risk

If Anthropic ships cross-lineage support in Ultrareview (a "bring your own
Bedrock / Vertex / OpenAI" mode) before this study completes, the
differentiator collapses entirely regardless of H1/H0. Watch
`code.claude.com/docs/llms.txt` and the weekly changelog. The competitive
landscape doc tracks re-validation cadence.

## Tasks

1. **M1** — Setup harness: install promptfoo, write `promptfooconfig.yaml`,
   capture PR diffs + specs, validate single test runs against each
   provider locally.
2. **M2** — Run full eval: 180 reviews across 8 providers × 4 PRs. Promptfoo
   handles parallelism + caching.
3. **M3** — Analysis: write `analyze.ts`, run, generate `delta-report.md`.
4. **M4** — Decision: read report, apply decision rule above, document the
   choice in this spec's commit history.

Each milestone is a single PR. M1 + M2 can land together since M2 has no
new code; M3 lands when analyze.ts is written and the report is generated.
