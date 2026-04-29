# Workflow: brainstorm → spec → sleep → PR

How features get from "I noticed something annoying" to a merged PR in this repo. Captured because we ran the loop end-to-end on the `prompt-context` / `prompt-freetext-qa` pair and want it documented.

## The loop

```
                   ┌──────────────────────────────┐
                   │  Manual use surfaces a pain  │
                   └──────────────┬───────────────┘
                                  │
                   ┌──────────────▼───────────────┐
                   │  /superpowers:brainstorming  │  (interactive)
                   │  → spec in docs/specs/       │
                   └──────────────┬───────────────┘
                                  │
                   ┌──────────────▼───────────────┐
                   │  Commit spec to main         │
                   └──────────────┬───────────────┘
                                  │
                   ┌──────────────▼───────────────┐
                   │  kuroboto sleeping start     │  (autonomous)
                   │  → branch + worktree + PR    │
                   └──────────────┬───────────────┘
                                  │
                   ┌──────────────▼───────────────┐
                   │  Review (manual + /code-review) │
                   └──────────────┬───────────────┘
                                  │
                   ┌──────────────▼───────────────┐
                   │  Squash merge + delete branch  │
                   └──────────────────────────────┘
```

## Step by step

### 1. Manual first

Don't write a spec for something you haven't actually used. The pain has to be real and concrete — "hard to know which session is asking" beats "we should make notifications more informative" by a mile. (Project rule: **manual first, formaliza em feature depois**.)

### 2. Brainstorm

Run `/superpowers:brainstorming` with a short pitch describing the pain and the rough idea. The brainstorm:

- Asks one question at a time, multiple-choice when possible
- Settles open design choices (data sources, format, edge cases, testing)
- Lands on a spec doc at `docs/specs/<feature>.md`

The spec is short and concrete: problem, solution sketch, files to create/modify, behavior details, audit changes, test plan, task breakdown (M1/M2/M3). Look at `docs/specs/allowlist-match.md` or `docs/specs/prompt-context.md` for examples.

### 3. Split when needed (orthogonal specs in parallel)

If a feature is large enough that it should split into multiple PRs, prefer **orthogonal specs**:

- Each spec touches different files / different code regions
- Shared modules (e.g., a helper consumed by both) are spec'd with the **canonical implementation reproduced verbatim** in each spec — both agents produce byte-identical files, git's 3-way merge dedups on PR-2 rebase
- Mention the split + dependency in each spec's `## Out of scope` section so the agents know what the other one is doing

This lets multiple sleep agents run in parallel without textual merge conflicts.

### 4. Commit specs to main

Specs are docs. Commit them straight to main (no PR) before launching sleep agents. Sleep agents read the spec from the worktree's checkout of main.

### 5. Dispatch sleep mode

```bash
kuroboto sleeping start --plan docs/specs/<feature>.md --repo /path/to/repo
```

The daemon:
- Slugifies the plan content → branch `sleep/<slug>-<rand6>`, worktree `~/.kuroboto/worktrees/<slug>-<rand6>`
- Spawns Claude Code in the worktree with a wrapper prompt that says "execute this plan task-by-task, run tests, commit per task, push, open PR"
- Notifies via Telegram on start, on each commit, on completion
- Hard-times-out after `sleepMaxDurationMs` (default 2h)

You'll get a Telegram notif when the PR opens. **Always run `/code-review` skill on the new PR** before reviewing yourself — this is mandatory until we wire it as a CI/PR-bot trigger. The 5-agent review catches real bugs that single-pass eyes miss (witnessed on PRs #11, #12, #13).

### 6. Review and merge

Pull up the PR. Read the auto-review comment. Skim the diff yourself. If something's off, comment on the PR and the next sleep iteration (or a manual session) addresses it. When happy:

```bash
gh pr merge <num> --squash --delete-branch
```

### 7. Run the next one

If you split into orthogonal specs, after PR-1 merges, dispatch sleep for spec 2. PR-2 was branched from main *before* PR-1 merged; it'll need a rebase, but if you specced for orthogonality, the rebase is clean (no overlapping line-edits).

## When NOT to use this loop

- **Tiny fixes**: typos, one-line bug fixes, doc tweaks — commit directly to main, no spec, no sleep. The project rule is **PR workflow for big features; small stuff direto no main**.
- **Exploration / spike**: if you don't know what the spec should look like yet, do a manual spike first (in your own session, not sleep). Once the design crystallizes, spec it.
- **Anything that needs human intuition during the work** — UI polish, copy-writing, ambiguous trade-offs that surface mid-implementation. Sleep agents work best on plans where the path is laid out. If a plan has "figure out as you go" segments, run it manually.
