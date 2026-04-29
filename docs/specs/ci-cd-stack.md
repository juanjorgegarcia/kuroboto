# CI/CD stack — GitHub Actions + release-please

> Status: planned. Spec G. No npm publish yet — kuroboto isn't polished enough for public registry.

## Problem

Today the repo has zero CI:
- PRs ship with `npm test` only verified locally; no green/red gate before merge
- No automated changelog, version bumping, or release tagging
- Trusting commit discipline alone for "what changed in v0.2 vs v0.1" is brittle

We already follow conventional commits (`feat(daemon):`, `fix(pty):`, `docs(specs):`). That's the input release automation needs. Time to wire the rest.

## Solution

Two GitHub Actions workflows + one config file:

1. **`.github/workflows/ci.yml`** — every PR + push to main:
   - Setup Node 20
   - Install deps (cache by lockfile hash)
   - `npx tsc --noEmit` (typecheck)
   - `npx vitest run` (test)
   - `npm run build` (compile dist/)
   - Status check shows up next to GitGuardian on PRs

2. **`.github/workflows/release.yml`** — push to main:
   - Runs [release-please-action](https://github.com/googleapis/release-please-action) (Google)
   - Parses commits since last release; if any `feat:`/`fix:` commits exist, opens or updates a "Release PR" that:
     - Bumps `version` in `package.json` per semver (feat → minor, fix → patch, `BREAKING CHANGE:` → major)
     - Generates/updates `CHANGELOG.md` grouped by type
   - Merging that PR creates a git tag `v<version>` and a GitHub Release with the changelog body

3. **`release-please-config.json`** + **`.release-please-manifest.json`** — checked into root:
   - Configures `release-type: 'node'`
   - Tracks current version
   - Optional: per-section grouping in changelog

**No npm publish for now** — kept as out of scope until the CLI is polished. When the time comes, adding it is a single workflow file (`.github/workflows/publish.yml` triggered on `release.published`) plus an `NPM_TOKEN` secret.

## Files

**Create:**
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `release-please-config.json`
- `.release-please-manifest.json`

**Modify:**
- `package.json` — confirm `version` field is the source of truth for release-please
- `AGENTS.md` — add a one-liner mentioning CI runs and release flow

## CI workflow detail

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run
      - run: npm run build
```

Single Linux runner is fine — the codebase has no platform-specific tests beyond the smokes documented in specs (which are manual). Adding Windows/macOS runners is cheap to revisit if cross-platform regressions surface.

## Release workflow detail

```yaml
name: Release
on:
  push:
    branches: [main]
permissions:
  contents: write
  pull-requests: write
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

`release-please-config.json` (initial):

```json
{
  "release-type": "node",
  "packages": {
    ".": {
      "package-name": "kuroboto",
      "include-component-in-tag": false
    }
  },
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance" },
    { "type": "docs", "section": "Documentation", "hidden": false },
    { "type": "refactor", "section": "Refactor", "hidden": true },
    { "type": "test", "section": "Tests", "hidden": true },
    { "type": "chore", "section": "Chores", "hidden": true }
  ]
}
```

`.release-please-manifest.json` (initial):

```json
{ ".": "0.2.0" }
```

Pin the current `package.json` version here so release-please picks up from the right baseline.

## Behavior details

- **No version bump for docs-only changes.** Pure `docs:` / `chore:` / `refactor:` commits don't trigger a Release PR. Only `feat:`/`fix:`/`perf:`/`BREAKING CHANGE:` do.
- **The Release PR is regenerated on every main push.** If you push 3 fixes back-to-back, the same Release PR keeps updating. Merge it once when ready.
- **Manual override.** If you need a hand-controlled version bump, edit `package.json` + `CHANGELOG.md` directly on a feature branch — release-please respects manual edits within the PR.
- **First release after wiring.** The bot will open a Release PR bumping to `0.2.1` (next patch) on the next `feat:` or `fix:` merge to main. The first changelog will list everything since `0.2.0` (the manifest's pinned start).

## Replicability

This pattern is intentionally generic — copy `.github/workflows/`, `release-please-config.json`, `.release-please-manifest.json` to another repo, edit:
- `package-name` in config
- starting version in manifest
- `release-type` if not Node (e.g., `python` for pyproject.toml-based projects)
- CI commands per stack

Same shape works for the user's other repos (PoeAltCrafter has its own spec mirroring this).

## Out of scope (follow-ups)

- **npm publish on release** — single workflow file (`publish.yml`) + `NPM_TOKEN` secret. Add when the CLI is polished and we want others to install.
- **Multi-platform CI** (Windows + macOS runners) — only if a cross-platform regression bites. Linux ubuntu-latest covers 90% of bugs.
- **Code coverage upload** (Codecov / Coveralls) — vitest supports `--coverage`; wire later if coverage becomes a goal.
- **Lint step** — `npm run lint` is a placeholder today. Wire ESLint or Biome separately, then add a step.
- **Provenance / signing** — comes with publish; defer.
- **Pre-release / beta channel** — release-please supports it via branch config; defer.

## Test plan

**Smoke (post-merge, manual):**
1. Open a tiny `fix:` PR (e.g., a typo). Verify CI runs, all green.
2. Merge that PR.
3. Wait ~30s; verify a "Release PR" titled `chore(main): release 0.2.1` appears.
4. Inspect the Release PR — `package.json` bumped, `CHANGELOG.md` updated.
5. Merge the Release PR.
6. Verify a git tag `v0.2.1` exists and a GitHub Release with changelog body is published.
7. Subsequent merges to main: confirm Release PR is recreated/updated correctly.

## Tasks

1. **M1**: Create `.github/workflows/ci.yml`. PR it; verify CI passes on the PR itself.
2. **M2**: Create `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release.yml`. PR them; merge.
3. **M3**: Smoke validate (Steps 1–7 above). PR a small fix to trigger the Release PR. Document one line in AGENTS.md mentioning the flow.
