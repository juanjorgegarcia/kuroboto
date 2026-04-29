# Fix `kuroboto sleeping cleanup` missing merged sleeps

> Status: planned. Tracks issue #27. Single-task fix — `gh pr list --head` is exact-match, not prefix, so the cleanup call always returns an empty list and the existing client-side filter never sees any merged sleeps.

## Problem

`kuroboto sleeping cleanup` always reports `(nenhum sleep mergeado para limpar)` even when there are merged `sleep/*` PRs with leftover worktrees. Confirmed via live data this session:

- `gh pr list --state merged --head sleep/ --json ...` → `[]`
- `gh pr list --state merged --json ...` (without `--head`) → includes the merged `sleep/ci-cd-stack-github-actions-release-xpg54c` (PR #8 in PoeAltCrafter)

`gh pr list --head <name>` is exact-match, not prefix-match. The current code at `src/cli/sleepingCleanup.ts:46-57` passes `--head sleep/` literally, which never matches any branch (no branch is *named* `sleep/`).

The client-side filter at line 65 — `.filter((p) => p.state === 'MERGED' && p.headRefName.startsWith('sleep/'))` — already does the right job, but it never has any input to filter because the gh call returns `[]`.

## Test gap (why the unit suite is green despite the bug)

`test/unit/cli/sleepingCleanup.test.ts:29-34` mocks `gh pr list` returning a hand-built `PR_LIST` that already contains `sleep/*` MERGED entries. The mock does **not** simulate gh's actual exact-match `--head` filtering, so the client-side filter operates on a non-empty list and the test passes. The assertion at line 49-58 even locks in the bug by asserting that `--head` and `sleep/` are passed as args.

## Solution

Drop the `--head sleep/` filter from the gh call. The existing `headRefName.startsWith('sleep/')` filter at line 65 keeps the behavior correct. `--limit 100` stays — same cap as today.

### Change A — `src/cli/sleepingCleanup.ts`

Replace the gh args array (line 47-54) so it no longer passes `--head sleep/`:

```ts
// gh's --head is exact-match, not prefix-match, so we list all merged PRs
// and rely on the headRefName.startsWith('sleep/') filter below.
const r = await deps.exec('gh', [
  'pr',
  'list',
  '--state', 'merged',
  '--json', 'number,headRefName,state',
  '--limit', '100',
]);
```

The existing `.filter((p) => p.state === 'MERGED' && p.headRefName.startsWith('sleep/'))` at line 65 stays exactly as-is — it's already correct, it was just never reached with non-empty input.

### Change B — `test/unit/cli/sleepingCleanup.test.ts`

The test at line 49-58 (`'passes --state merged + --head sleep/ to gh'`) currently asserts the buggy args. Replace its assertions to:

- Assert `--state` and `merged` are passed (still required)
- Assert `--head` is **not** passed (regression guard against re-introducing the bug)
- Keep the existing args otherwise

The other tests (filtering by client-side `startsWith('sleep/')`, error handling, JSON parsing, empty-list path) already cover the right behavior — the mock returns a `PR_LIST` that includes `sleep/*` MERGED entries plus a `main` MERGED entry, and the assertions verify only the `sleep/*` slugs come through. Those tests stay green without modification.

Rename the test if desired: from `'passes --state merged + --head sleep/ to gh'` to `'passes --state merged to gh and does not pass --head'`.

## Files

**Modify:**
- `src/cli/sleepingCleanup.ts` — remove `'--head', 'sleep/'` from the gh args array (Change A)
- `test/unit/cli/sleepingCleanup.test.ts` — update the args-assertion test (Change B)

**No new files.**

## Behavior details

- **Repos with hundreds of merged PRs:** the `--limit 100` cap stays. If a repo has more than 100 merged PRs since the cleanup last ran, older merged sleeps could be missed. This is the same limit the (broken) version had — not making it worse, and out-of-scope for this fix.
- **`gh pr list` rate limits:** returning 100 PRs vs the previous (broken) call returning 0 is a single API call either way; no rate-limit concern.
- **No persisted state changes.** Cleanup is fire-and-forget; nothing to migrate.
- **`gh search` alternative considered.** `gh search prs --repo X "head:sleep/" is:merged` would push the prefix filter server-side, but it's a different command shape (output JSON differs) and the client-side filter we already have is fine for ≤100 PRs. Keep the surface change minimal.

## Out of scope

- Refactoring `cleanupMerged` itself — that function works correctly when given input.
- Adding `--limit` as a configurable flag.
- Any UI / output formatting changes.
- Auto-prune-on-merge (a separate idea — closing this loop entirely so manual `cleanup` is unnecessary). Not now.

## Test plan

**Unit (vitest):** all 442 existing tests stay green; the args-assertion test (Change B) is updated to reflect the new args. Verify:

```
npm run build && npm test
```

**Manual smoke (post-merge):** synthetically create a `sleep/test-fix-XXX` branch, open a PR, merge it, leave a marker file in `~/.kuroboto/worktrees/test-fix-XXX/`, run `kuroboto sleeping cleanup`. The cleanup should detect the merged sleep, prompt for confirm, and clean both worktree (if present) and branch.

## Tasks

1. Apply Change A in `src/cli/sleepingCleanup.ts`.
2. Apply Change B in `test/unit/cli/sleepingCleanup.test.ts`.
3. `npm run build && npm test` — all 442 tests green.
4. Open PR titled `fix(cli): sleeping cleanup detects merged sleeps (drop bogus --head filter)`. Body: link issue #27 and summarize root cause + fix in 2-3 lines. PR body must include `Closes #27` so merge auto-closes the issue.
