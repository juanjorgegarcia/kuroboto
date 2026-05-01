# Appliance hardware feasibility study

> Status: planned. Spec for an empirical hardware benchmark, **not for execution
> via sleep mode** — runs require physical hardware in hand and a person
> watching power meters. Drives the appliance pivot decision in
> `docs/competitive-landscape.md`: do we have a hardware ceiling that makes
> "buy a Mac Mini, plug it in, forget about it" actually viable, or does
> ollama choke on the only models good enough to be useful?

## Problem

The appliance pivot (kuroboto as self-hosted private cloud, see
`docs/competitive-landscape.md`) hinges on one open question that no amount of
LLM research can answer: **does cheap consumer hardware run a useful local
coding LLM at usable latency, while also hosting the kuroboto daemon and
multiple parallel sleep worktrees?**

If yes: the appliance pitch works (Mac Mini-class hardware runs the whole
stack, owner unplugs cloud dependencies entirely).

If no: ollama is window dressing and the appliance always falls back to cloud
LLM calls (Anthropic / OpenAI / OpenCode Zen), which negates "data-
sovereignty" as a moat — and the appliance becomes "a server that holds your
filesystem while still calling the same SaaS APIs Ultrareview uses."

This spec defines the benchmark. It does **not** run it — runs require
physical hardware and a person.

## Hardware scenarios to test

Three tiers, picked for "what would I actually buy":

### Tier A — Apple Silicon (target persona: dev who already lives in macOS)

| Model | Spec | Approx cost |
|---|---|---|
| Mac Mini M4 16GB | M4, 10-core CPU, 10-core GPU, 16GB unified | $799 |
| Mac Mini M4 24GB | M4, 10-core CPU, 10-core GPU, 24GB unified | $1099 |
| Mac Mini M4 Pro 24GB | M4 Pro, 12-core CPU, 16-core GPU, 24GB unified | $1399 |

Apple Silicon's unified memory makes it punch above weight for inference. The
question is whether 16GB is enough or you need to upsell to 24GB+ for
qwen-coder 32B.

### Tier B — x86 + consumer GPU (target persona: dev who builds PCs)

| Build | Spec | Approx cost |
|---|---|---|
| Mini-ITX + RTX 4060 8GB | i5-13500, 32GB DDR5, RTX 4060 8GB VRAM | ~$1300 |
| Mini-ITX + RTX 4070 12GB | i5-13500, 32GB DDR5, RTX 4070 12GB VRAM | ~$1700 |
| Used RTX 3090 24GB build | i5-13500, 32GB DDR5, used RTX 3090 24GB | ~$1800 |

VRAM is the bottleneck for cuda inference. 8GB locks you out of 32B models
entirely; 12GB is borderline; 24GB runs everything but used 3090s are crusty.

### Tier C — Edge / cheap (target persona: home server hobbyist)

| Build | Spec | Approx cost |
|---|---|---|
| Jetson Orin Nano Super 8GB | ARM, 8GB shared, 67 TOPS | $499 |
| Raspberry Pi 5 16GB | ARM, 16GB | $120 |
| Hetzner AX52 dedicated | AMD Ryzen 7 7700, 64GB DDR5, 2×NVMe | €60/mo |

Pi 5 is almost certainly DOA for LLM inference; included as the floor reference.
Hetzner is the "I don't want hardware in my house" option — cheaper TCO than
Mac Mini over 2 years, but co-located, so privacy story weakens.

## Models to benchmark

Per `research/cross-model-review-study/` smoke results (2026-04-30), the
ollama-tier already covered:
- `qwen2.5-coder:7b` (4.7GB, fits 8GB+ VRAM/RAM)
- `llama3.1:8b` (4.9GB, same)
- `deepseek-coder:6.7b` (3.8GB, generous)

For the appliance to actually be useful for cross-lineage review (Spec R),
add the larger coder models:

- **qwen2.5-coder:32b** (~19GB, requires 24GB+ unified or 24GB VRAM)
- **deepseek-coder-v2:16b** (~9GB) — middle ground
- **llama3.3:70b-instruct-q4_K_M** (~40GB) — only on Tier B 24GB+ builds, stretch

If a tier can't run any model >7B at usable speed, mark the tier "not
appliance-grade for cross-lineage review" and move on.

## Benchmark method

For each (hardware × model) combination:

### M1 — Cold start latency

Time from `ollama run <model>` (model not in RAM) to first token. Models that
take >30s to warm up break the "auto code-review on PR open" UX — the
PR's HEAD commit needs review feedback within ~2 min after open or developers
move on.

### M2 — Steady-state throughput

After warmup, run the actual `prompt.txt` from the cross-model-review study
against PR #29's diff (~14k input tokens, ~2-4k output expected). Capture:

- Tokens/sec output
- Total wall time per review
- P50 / P95 latency over 10 consecutive runs
- Memory peak (RSS), GPU memory peak (if applicable)

Decision threshold: a review must complete within **120 seconds** wall time
to be appliance-viable. Beyond that, the user habit of "open PR, hit refresh,
see review" breaks down.

### M3 — Concurrency stress

Critical for the appliance: kuroboto's max_concurrent sleeps default is 6.
Run 3 simultaneous reviews of PR #29 against the same model. Capture:

- Wall time of slowest run vs solo baseline (degradation factor)
- Whether ollama serializes (single-instance bottleneck) or parallelizes
- Total throughput (3× single? half? worse?)
- Memory blow-up — does the model load 3× into memory or share?

Decision threshold: 3-concurrent should not degrade individual run more than
**3×** vs solo. Beyond that, sleep mode parallelism is fictional on this
hardware.

### M4 — Power consumption

Plug the host into a kill-a-watt or use `powermetrics` (macOS) /
`turbostat` (Linux) and capture:

- Idle baseline (daemon up, no workload)
- Single-review steady-state
- 3-concurrent peak

Multiply by $0.15/kWh × 24h × 365d for the always-on cost. Mac Mini is
~5W idle, ~30W under load; consumer GPU rigs idle at 50W+ and peak at 250-
400W. Over a year, that's the difference between $7 and $400 in electricity.

### M5 — Daemon coexistence

Run the kuroboto daemon (existing, no LLM change) alongside the worst-case
benchmark from M3. Capture:

- Daemon process RSS during ollama load
- Latency of `kuroboto status` calls (proxy for daemon responsiveness)
- Any audit-log write contention (ollama writes lots, daemon writes audits)

If the daemon noticeably degrades when ollama is hot, the appliance design
needs process isolation (cgroups, separate user, nice/ionice, or container
boundaries).

## Tools

- `ollama bench` (built-in if available) or hand-rolled `time ollama run`
- `time` for wall-clock; `/usr/bin/time -v` on Linux for RSS
- `htop`, `nvtop` (NVIDIA), `asitop` (Apple Silicon) for live observation
- `powermetrics` (macOS), `turbostat` + `nvidia-smi` (Linux)
- `k6` or simple `xargs -P3` for concurrency stress

Capture all output into `research/appliance-hardware-bench/<hardware-id>/`,
one file per `(hardware × model × scenario)` combo. Format: tab-separated,
one row per run.

## Decision criteria

Score each hardware tier on a 0-3 scale across the four pillars:

| Pillar | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Latency (M1+M2) | review >300s | 120-300s | 60-120s | <60s |
| Concurrency (M3) | serializes | <2× | 2-3× degradation | linear |
| Power (M4) | >100W avg | 50-100W | 20-50W | <20W |
| Coexistence (M5) | daemon stalls | noticeable | minor | none |

A tier is **appliance-grade** if total score ≥ 8/12 with no individual pillar
at 0. Below that, the tier serves only as "nice-to-have offline mode" — the
appliance still has to call cloud LLMs for real work.

## Deliverable

`research/appliance-hardware-bench/report.md`:

1. **TL;DR** — recommended hardware tier with one-line justification
2. **Per-hardware scorecard** — the 4×N table above filled in
3. **Cost-of-ownership 3-year** — purchase + electricity + replacement risk
4. **Open issues found during benchmark** — driver bugs, ollama gotchas,
   thermal throttling under load, etc.

## Out of scope (v1)

- AMD ROCm GPUs (immature stack, ollama support flaky as of writing)
- Cloud GPU rentals (defeats the appliance purpose)
- Quantization tradeoff curves — pick one quantization per model (Q4_K_M
  default), don't sweep
- Speculative decoding tuning
- Custom kernels / vLLM / TensorRT — out of scope for "boring appliance"

## Not running yet

This spec executes only when:

1. The owner has at least one hardware tier physically in hand, OR
2. A Hetzner Tier-C trial is acceptable as the floor (~€60 for a month of
   benchmarking)

Until then, this is a **dormant spec**. Re-open and execute when hardware
shows up or appliance pivot is escalated to active work.

## Related

- `docs/competitive-landscape.md` — appliance pitch context
- `docs/specs/cross-model-review-delta-study.md` — Spec R, depends on
  ollama-tier latency for any cross-lineage review feature shipping in
  appliance mode
- `research/cross-model-review-study/` — has working ollama harness (smoke
  v5 results) that this spec extends
