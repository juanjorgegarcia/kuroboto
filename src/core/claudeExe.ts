import { spawnSync } from 'node:child_process';

/**
 * Resolve the absolute path of the `claude` executable on Windows; passthrough
 * `'claude'` on POSIX. Two reasons this matters on Windows:
 *
 * 1. node-pty bypasses PATHEXT on Windows when `useConpty: true`, so a bare
 *    `'claude'` won't find `claude.cmd` or `claude.exe`. See node-pty #471
 *    discussion thread.
 *
 * 2. Node's `child_process.spawn` with `shell: false` rejects `.cmd`/`.bat`
 *    files for security since 18.20.2 (CVE-2024-27980). Resolving the
 *    absolute path lets the caller branch on the suffix and decide whether
 *    `shell: true` is required.
 *
 * Returns:
 *   - On POSIX: `'claude'` (PATH resolution is the kernel's job).
 *   - On Windows: the absolute path of the first `where claude` hit
 *     (typically `claude.exe` from the binary installer or `claude.cmd`
 *     from `npm install -g`), or `'claude'` if `where` fails — in which
 *     case the spawn will error with a clear message.
 */
export function resolveClaudeExecutable(): string {
  if (process.platform !== 'win32') return 'claude';
  try {
    const r = spawnSync('where', ['claude'], { encoding: 'utf-8', windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/)[0]?.trim();
      if (first) return first;
    }
  } catch {
    // ignore — fall through to bare 'claude'
  }
  return 'claude';
}

/**
 * Pure suffix check — no platform branch. Useful in tests so the
 * .cmd-handling logic is exercised on every runner regardless of OS.
 */
export function isCmdOrBat(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * `child_process.spawn` with `shell: false` cannot launch `.cmd`/`.bat`
 * directly on Node ≥ 18.20.2 (CVE-2024-27980). When the resolved
 * executable ends in `.cmd`/`.bat`, callers must pass `shell: true`.
 *
 * Returns true on Windows when the path's extension requires shell mode.
 * Always false on POSIX.
 */
export function requiresShellOnWindows(resolvedExe: string): boolean {
  if (process.platform !== 'win32') return false;
  return isCmdOrBat(resolvedExe);
}

/**
 * Thrown by `claudeSpawn` when the resolved Claude executable is `.cmd`
 * (typical `npm install -g @anthropic-ai/claude-code` install on
 * Windows). Going through cmd.exe to launch `.cmd` would let it re-parse
 * `& | < > ^` in args, AND cmd.exe cannot preserve embedded newlines —
 * which kuroboto's sleep prompts (multi-line markdown specs) always
 * have. There is no robust escape: writing the prompt to a temp file
 * and switching the spawn signature is doable but invasive enough to
 * warrant its own spec. Until then, fail loud and point to the binary
 * installer (which produces `.exe` and works on `shell: false`).
 */
export class ClaudeCmdInstallUnsupportedError extends Error {
  constructor(public readonly resolvedPath: string) {
    super(
      `kuroboto cannot launch the npm-installed Claude Code on Windows reliably ` +
        `(\`${resolvedPath}\` ends in .cmd, which cmd.exe parses with metachar + newline ` +
        `quirks that break multi-line spec dispatches). ` +
        `Workaround: install Claude Code via the official binary installer instead — ` +
        `it produces \`claude.exe\` which kuroboto launches with shell:false directly. ` +
        `See https://github.com/anthropics/claude-code for binary download links.`,
    );
    this.name = 'ClaudeCmdInstallUnsupportedError';
  }
}
