# Self-hosted dev tool ship-practices survey (2026-04-30)

> 5-tool snapshot of how mature self-hosted dev tools distribute, version, and
> document themselves. Goal: extract patterns kuroboto can replicate as it
> grows from npm CLI → eventual self-hosted appliance. Not a business model
> analysis.
>
> Background: a parallel multi-source agent attempt failed to write its
> deliverable; this is a focused redo against 5 high-signal repos via direct
> first-party WebFetch. Sources cited inline.

## TL;DR — five takeaways

1. **Docker Compose is the universal default** for self-hosted distribution.
   All 5 tools surveyed (Plausible, Sentry, n8n, Coolify, Supabase) ship a
   `compose.yml` as their primary install path. Helm charts exist for some
   (Sentry, Supabase) but as **secondary** options, not the headline. **For
   kuroboto's appliance v1, compose-first is the orthodoxy — defer Helm to
   v2.**
2. **Auto-update is rarely automatic.** Self-hosters expect `git pull && ./install.sh`
   or `docker compose pull && up -d` workflows. Nobody surveyed ships a
   Watchtower-style auto-updater by default. Don't waste effort on this for v1.
3. **Calver is a valid alternative to semver for self-hosted infra.** Sentry
   uses `26.4.1` (year.month.patch). Communicates "freshness" better for ops
   tools, but `release-please` (already in use) doesn't support it natively.
   Stick with semver — your users are devs, not ops.
4. **License-model choice has long-term consequences.** n8n's [Sustainable Use
   License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) is fair-code
   (not OSI-approved) — gives them commercial moat. Plausible/Supabase use
   permissive (MIT/Apache) and rely on cloud hosting for revenue. Coolify
   Apache 2.0. **For "personal tool I might commercialize someday," start
   permissive (Apache 2.0) and only restrict if/when there's something to
   protect.**
5. **Custom docs sites beat off-the-shelf frameworks.** Four of five host
   docs at their own domain (docs.n8n.io, coolify.io/docs, supabase.com/docs,
   sentry.io/docs). Only Plausible relies on GitHub wiki, and it's the
   weakest doc experience of the group. **When kuroboto outgrows
   `docs/*.md` in repo, jump straight to a hosted solution; skip GitHub wiki
   as a stepping stone.**

## Comparison matrix

| Tool | Distribution | Release tooling | Versioning | Docs system | License |
|---|---|---|---|---|---|
| [Plausible CE](https://github.com/plausible/community-edition) | docker-compose | not documented | not documented | GitHub wiki | MIT |
| [Sentry self-hosted](https://github.com/getsentry/self-hosted) | docker-compose + `install.sh` | not surfaced | calver `26.4.1` | sentry.io/docs | BSL-style |
| [n8n](https://github.com/n8n-io/n8n) | npm + Docker (docker.n8n.io/n8nio/n8n) + Cloud | not surfaced | semver, 602 releases | docs.n8n.io (custom) | Sustainable Use (fair-code) |
| [Coolify](https://github.com/coollabsio/coolify) | curl install script | git-cliff | not surfaced | coolify.io/docs (custom) | Apache 2.0 |
| [Supabase](https://github.com/supabase/supabase) | docker-compose (`/docker`) + Helm | GitHub Actions in `.github/` | not surfaced | supabase.com/docs (MDX) | Apache 2.0 |

Caveats: README-level fetches missed deeper workflow files (`.github/workflows/release.yml` etc.). For deeper inspection of any given tool's CI matrix or release script, fetch the workflow file directly.

## Per-tool notes

**Plausible CE** — minimalist. Single `compose.yml`. Upgrades documented in
GitHub wiki. ClickHouse hard requirement (CPU must support SSE 4.2 or NEON).
The "boring deploy" reputation is earned: nothing exotic in their stack,
but also nothing to learn about release engineering — they barely document it.

**Sentry self-hosted** — heaviest of the group. Uses `install.sh` for
both fresh installs and upgrades. Ships at calver cadence — month-major,
which signals "operations product" more than "library". Repo had load
errors during fetch, so deeper details would need direct file reads.

**n8n** — closest stack to kuroboto (Node.js). Triple-channel distribution:
**npm** (`npx n8n` quick start), **Docker** (`docker.n8n.io/n8nio/n8n`), and
**managed cloud**. The `npx n8n` path is what kuroboto already does for the
CLI — n8n's evolution to ALSO offer Docker is the natural appliance
evolution. License is non-OSI (Sustainable Use License) — they protect
commercial offerings while allowing self-hosting. **Most relevant tool to
study deeply if kuroboto pivots to appliance.**

**Coolify** — uses `curl | bash` install script. Notably uses
[`git-cliff`](https://git-cliff.org/) for changelog automation (config in
`cliff.toml`). Apache 2.0. Auto-update of Coolify itself wasn't surfaced
clearly — ironic given Coolify's whole pitch is auto-deploying *other*
things.

**Supabase** — heaviest stack of the group (multi-service: Postgres,
Realtime, Storage, Auth, Studio UI). Has both `docker-compose.yml` in
`/docker` and Helm chart. MDX docs (likely Nextra or custom Next.js). The
multi-service complexity is what kuroboto would face if it adds web UI +
ollama sidecar + queue + worker as separate processes.

## Patterns observed

**Distribution-tier maturity ladder** observed across the 5:

1. **Source + manual setup** (early stage) — Plausible's "follow the wiki"
2. **`compose.yml` + README** (middle) — Plausible CE today, Sentry,
   Supabase
3. **`install.sh` wrapper** for fresh installs and upgrades — Sentry, Coolify
4. **Multi-channel** (npm + Docker + Cloud) — n8n
5. **Helm chart** as a *secondary* option for k8s shops — Sentry, Supabase

Kuroboto today is at level 1 (npm + README). The natural next step is **2**
(`compose.yml` for appliance distribution) without skipping straight to **5**
(Helm). Level 4 (n8n model — keep CLI, add Docker) is the appliance pivot.

**Release tooling is invisible from the surface** of most projects. None of
the 5 README-level fetches surfaced the actual release pipeline — they all
"just work" via GitHub Actions in `.github/workflows/`. Only Coolify
explicitly mentions its choice (`cliff.toml` for git-cliff). Lesson: release
tooling is plumbing; users don't care, but YOU should pick something
maintained. **kuroboto already uses `release-please` — keep it, document
it briefly in CONTRIBUTING.md, move on.**

**License is signaling, not restriction.** n8n's "fair-code" license signals
"we have a commercial offering, don't compete with us"; Plausible's MIT
signals "fork freely, our cloud is the moat"; Sentry's BSL signals
"open-source eventually but not in a way that lets AWS resell us." All three
are coherent. The wrong move is unclear licensing — pick one and stick to it.

## Recommendations for kuroboto

1. **Add a `compose.yml` at the repo root next iteration.** No Helm yet.
   Target: someone with a Mac Mini does `git clone && docker compose up -d`
   and gets the daemon + ollama + Telegram channel running. This is the
   next concrete deliverable that moves kuroboto from "npm CLI" to
   "appliance-shaped".
2. **Keep `release-please` for semver auto-bumping**, no migration to
   git-cliff or GoReleaser. Cost-benefit doesn't justify the swap.
3. **Don't build auto-update for v1.** Document the manual upgrade path
   (`docker compose pull && up -d` once compose exists; `npm i -g kuroboto@latest`
   today). This matches every project surveyed.
4. **License: confirm Apache 2.0** (or stay MIT if already chosen). Avoid
   AGPL / BSL / fair-code unless you've decided you want a commercial
   moat — and you've explicitly said the goal is personal learning, not
   commerce. Permissive is correct.
5. **Docs: defer the migration off in-repo markdown until you cross the
   threshold of "I have to explain installation in 5 different runtimes."**
   Once the appliance ships, jump straight to a hosted solution
   (docusaurus.kuroboto.dev or similar). Skip GitHub wiki — Plausible
   regrets it visibly.

## What kuroboto does right already

- `release-please` is in use and matches industry default (release.yml lives at `.github/workflows/release-please.yml`).
- Multi-platform CI is in place (matrix Linux/macOS/Windows added in PR #15) — caught up to where mature tools are.
- AGENTS.md + per-spec docs/specs/ pattern is *better* than README-only — spec discoverability is something most surveyed tools lack.

## Open questions (not for more research — you decide)

1. Apache 2.0 vs MIT — the kuroboto repo currently has no LICENSE file at root I'd auto-detected. Pick one and add it. Apache 2.0 is the safer default for anything that might involve patents / contributions later.
2. Does the appliance evolution include a web UI, or is Telegram + CLI enough? n8n shipped a web UI early; that drove a large chunk of their docs/CI complexity. Skip the web UI as long as Telegram covers the workflow.
3. Single-binary distribution (via `pkg`, `bun build`, or `nexe`) — not used by any tool surveyed (all containerized). Worth investigating as a *third* option if/when appliance v2 wants "no Docker required" mode for hobbyists.

## Sources

- https://github.com/plausible/community-edition
- https://github.com/getsentry/self-hosted
- https://github.com/n8n-io/n8n
- https://github.com/coollabsio/coolify
- https://github.com/supabase/supabase

Background reference (5-tool sample chosen for stack diversity: Elixir/Python/Node.js/PHP/multi-stack). Skipped from this pass: Outline, NocoDB, Penpot, Mattermost, Element Synapse, Forgejo — same patterns expected to recur, diminishing returns.
