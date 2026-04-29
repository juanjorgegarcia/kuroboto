# CLI layer tests

> Status: planned. Spec H. Closes the test-coverage gap between the daemon's HTTP layer (already covered by integration tests) and what the user actually types — output formatting, argument parsing, interactive prompts, exit codes.

## Problem

Today every layer below the CLI has automated tests:
- Unit tests cover the orchestrator (`SleepingOrchestrator`), TopicManager, transcript parser, etc.
- Integration tests cover the daemon's HTTP routes (`POST /v1/sleeping`, `POST /v1/permission`, …)
- 308/308 passing.

But the CLI commands (`kuroboto sleeping start --prompt …`, `kuroboto gaming on 15m`, `kuroboto audit list`, etc.) are **not** automatically tested. Their behaviors — argument parsing, output formatting, interactive prompts, exit codes — are validated only by manual smoke checklists in each spec.

This was acceptable while the CLI surface was small. After Spec D (parallel sleeps with new `cancel` UX, capacity-reached rendering, multi-line status output) and the CI/CD setup, the gap is the most likely source of regressions.

## Solution

Add a `test/unit/cli/` directory with one spec file per subcommand group. Each test:

- Stubs `global.fetch` via `vi.stubGlobal('fetch', vi.fn(...))` — simulates daemon responses without running one
- Mocks `prompts` lib via `vi.mock('prompts')` — controls user input on confirmation prompts
- Captures stdout / stderr via `vi.spyOn(process.stdout, 'write')` — asserts on output
- Captures exit code via `vi.spyOn(process, 'exit')` — asserts on success/failure paths

Tests run offline, fast (~5s for the whole suite), zero external dependencies (no daemon, no Telegram, no tmux). They live alongside the existing `test/unit/` tree.

## Files

**Create:**
- `test/unit/cli/sleeping.test.ts` — `kuroboto sleeping start | status | cancel` (the feature with the most surface area, post-Spec D)
- `test/unit/cli/gaming.test.ts` — `kuroboto gaming on | off | status`
- `test/unit/cli/audit.test.ts` — `kuroboto audit list | export`
- `test/unit/cli/allowlist.test.ts` — `kuroboto allowlist list | export`
- `test/unit/cli/mode.test.ts` — `kuroboto here | away`
- `test/helpers/cliHarness.ts` — shared helpers: `stubFetch(handler)`, `mockPrompts(answers)`, `captureStdout()`, `runWithExitCapture(fn)`

**Modify:**
- `vitest.config.ts` — no change expected; existing config picks up `test/unit/cli/**` automatically via the test glob
- (None of the CLI source files change.)

## Test approach — concrete patterns

**Stub fetch with handler:**

```ts
import { vi } from 'vitest';

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    return handler(u, init);
  }));
}

// Usage:
stubFetch((url) => {
  if (url.endsWith('/v1/sleeping')) {
    return new Response(JSON.stringify({ active: [], capacity: 6 }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
});
```

**Mock prompts:**

```ts
import { vi } from 'vitest';

vi.mock('prompts', () => ({
  default: vi.fn(async (question: { name: string; type: string }) => {
    // return prepared answers
    return { val: true };  // override per test
  }),
}));
```

**Capture stdout + exit:**

```ts
const writes: string[] = [];
const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
  writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
  return true;
});
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?) => {
  throw new Error(`__exit__:${code ?? 0}`);  // throw to short-circuit, catch in test
}) as unknown as typeof process.exit;

await expect(sleepingStartCommand({ prompt: 'x' })).rejects.toThrow(/__exit__/);

expect(writes.join('')).toContain('💤 sleep started');
expect(exitSpy).toHaveBeenCalledWith(0);
```

(Helper `runWithExitCapture` wraps this pattern.)

## Coverage breakdown per file

### `sleeping.test.ts` (~12 tests)

- `status` with empty `active: []` → prints `sleep: idle (cap 6)`
- `status` with one active → prints 1 line with slug + remaining
- `status` with multiple → prints `sleep: N active (cap 6)` + N lines
- `start --prompt X` happy path → POSTs to /v1/sleeping, prints "💤 sleep started" + slug + branch + worktree
- `start --plan ./plan.md` → reads file, posts plan content, plus PLAN_INTRO behavior
- `start` rejects when both `--prompt` and `--plan` given
- `start` rejects when neither given
- `start` at capacity (429) → renders capacity-reached output (cap, active list), exits 1
- `cancel` with no active → prints "(no active sleeps)", exits 0
- `cancel` with one active → confirmation prompt with slug → on `y` cancels → prints success
- `cancel <slug>` → cancels without prompt, prints success
- `cancel <slug>` (slug not found) → exits 1 with clear error
- `cancel --all` (multiple active) → prompt lists all → on `y` cancels all → prints summary
- `cancel --yes` (single active) → no prompt, cancels
- `cancel --yes` (multi active, no slug) → silently picks most-recent (validates documented behavior)

### `gaming.test.ts` (~8 tests)

- `on` → PUT /v1/gaming `{on: true}`, prints "gaming armed"
- `on 15m` → POST with `durationMs: 900_000`, prints "armed for 15m"
- `on 2h` → POST with `durationMs: 7_200_000`
- `on bad` → fails parsing → exits 1
- `off` → PUT `{on: false}`
- `status` (active) → prints "gaming: active" + remaining if has timer
- `status` (idle) → prints "gaming: off"
- daemon offline → fetch fails → exits 1 with daemon-down message

### `audit.test.ts` (~6 tests)

(Like `allowlist`, this command reads filesystem directly — `~/.kuroboto/audit.jsonl` — instead of going through the daemon. That keeps `kuroboto audit list` usable for diagnostics even when the daemon is offline. Tests stub `readAudit` rather than `fetch`.)

- `list` (no args) → calls `readAudit({})`, prints last entries
- `list --since 5m` → forwards `sinceMs=300000`
- `list --cwd /path` → forwards `cwd=/path`
- `list --limit 50` → forwards `limit=50`
- `export` → prints raw JSONL to stdout (machine-readable)
- empty log → prints `(sem entradas)` placeholder

### `allowlist.test.ts` (~5 tests)

(Different from above — these read filesystem directly, not daemon. Mock `fs`.)

- `list` (default cwd) → reads `<cwd>/.claude/settings.local.json`, prints allow + deny entries
- `list /path` → reads that path's settings
- `list` with missing settings file → prints "(empty)" / exits 0
- `list` with malformed JSON → prints error, exits 1
- `export` → JSON dump of the parsed entries

### `mode.test.ts` (~4 tests)

(`mode` writes to `~/.kuroboto/state.json` first, then best-effort PUTs `/v1/mode` so the running daemon picks up the change immediately. Daemon-offline is a soft failure here — the local change persists and the next daemon start will read it.)

- `kuroboto here` → saves locally, PUTs `/v1/mode {mode: 'here'}`, prints "mode set to here"
- `kuroboto away` → saves locally, PUTs `/v1/mode {mode: 'away'}`, prints "mode set to away"
- daemon offline (here) → still saves locally and reports `daemon offline` fallback (no exit 1)
- daemon returns non-2xx → still saves locally, includes HTTP code in fallback message

## Behavior details / conventions

- **No real daemon ever spawned.** All HTTP via `fetch` stub. Speed: ~5ms per test.
- **No real prompts** — `prompts` lib is mocked, answers are scripted.
- **Process exit is throwable.** Tests catch via `__exit__:N` sentinel pattern, then assert exit code.
- **Stdout/stderr captured separately.** Don't accidentally assert on color codes — strip ANSI in helper.
- **Existing tests untouched.** New `test/unit/cli/` tree is purely additive.

## Out of scope (follow-ups)

- **`kuroboto init`** — the interactive wizard has 10+ prompts and side-effects (writes config file, merges hooks into `~/.claude/settings.json`, calls Telegram for chat_id discovery). Worth a dedicated spec (`init-tests.md`) — too big to fit here without losing focus.
- **`kuroboto start | stop | status`** — process lifecycle (spawns/kills daemon). Real process management is manual-smoke territory; mocking `child_process.spawn` is brittle.
- **`kuroboto claude` / `ohayo`** — these spawn child processes (claude, tmux). Same reasoning.
- **`kuroboto hook <type>`** — internal API. Already covered indirectly via daemon integration tests.
- **End-to-end shell integration** — running the actual `kuroboto` binary via `child_process.spawnSync`. Would need a built dist + npm-link. Manual smoke covers it.

## Test plan

For each new test file: ~5–15 tests, all passing. Total ~35 tests added, ~308 → ~343.

Manual smoke (post-merge, run the original Spec D smoke from its test plan once to confirm CLI works against a live daemon — quick sanity check that the mock-based tests didn't drift from reality):

```bash
kuroboto sleeping status                     # → idle (cap 6)
kuroboto sleeping start --prompt "echo hi"
kuroboto sleeping start --prompt "echo hi 2"
kuroboto sleeping status                     # → 2 active
kuroboto sleeping cancel --all --yes         # → cancels both
```

If CLI output matches what the unit tests assert on, the mock layer is faithful.

## Tasks

1. **M1**: Create `test/helpers/cliHarness.ts` with `stubFetch`, `mockPrompts`, `captureStdout`, `runWithExitCapture`. Add `test/unit/cli/sleeping.test.ts` (15 tests). Verify all pass via `npx vitest run test/unit/cli/sleeping.test.ts`.
2. **M2**: Add `test/unit/cli/gaming.test.ts` + `test/unit/cli/mode.test.ts` (state-toggle commands).
3. **M3**: Add `test/unit/cli/audit.test.ts` + `test/unit/cli/allowlist.test.ts` (data-read commands; allowlist mocks fs instead of fetch). Run full suite — all 343 tests passing. PR.
