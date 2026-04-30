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
 * `child_process.spawn` with `shell: false` cannot launch `.cmd`/`.bat`
 * directly on Node ≥ 18.20.2 (CVE-2024-27980). When the resolved
 * executable ends in `.cmd`/`.bat`, callers must pass `shell: true`.
 *
 * Returns true on Windows when the path's extension requires shell mode.
 * Always false on POSIX.
 */
export function requiresShellOnWindows(resolvedExe: string): boolean {
  if (process.platform !== 'win32') return false;
  const lower = resolvedExe.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}
