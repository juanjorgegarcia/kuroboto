/**
 * Coverage for the Windows-specific spawn-resolution helpers. The real
 * `where claude` lookup can't be deterministically tested cross-runner, so
 * the resolution path is exercised only as far as its branching contract.
 */
import { describe, it, expect } from 'vitest';
import { resolveClaudeExecutable, requiresShellOnWindows } from '../../src/core/claudeExe.js';

describe('resolveClaudeExecutable', () => {
  it("returns 'claude' verbatim on POSIX", () => {
    if (process.platform === 'win32') return; // skip on Windows runners
    expect(resolveClaudeExecutable()).toBe('claude');
  });

  it('returns either an absolute path or fallback string on Windows', () => {
    if (process.platform !== 'win32') return; // skip on POSIX
    const result = resolveClaudeExecutable();
    // Either a real where-claude hit (absolute path) or the fallback.
    // Both shapes are valid; what we assert is the function never throws.
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('requiresShellOnWindows', () => {
  it('always returns false on POSIX regardless of extension', () => {
    if (process.platform === 'win32') return;
    expect(requiresShellOnWindows('claude')).toBe(false);
    expect(requiresShellOnWindows('/path/to/claude.cmd')).toBe(false);
    expect(requiresShellOnWindows('C:\\path\\to\\claude.cmd')).toBe(false);
  });

  it('returns true for .cmd / .bat on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(requiresShellOnWindows('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd')).toBe(true);
    expect(requiresShellOnWindows('C:\\path\\claude.CMD')).toBe(true); // case-insensitive
    expect(requiresShellOnWindows('C:\\path\\claude.bat')).toBe(true);
  });

  it('returns false for .exe on Windows (binary install)', () => {
    if (process.platform !== 'win32') return;
    expect(requiresShellOnWindows('C:\\Users\\x\\.local\\bin\\claude.exe')).toBe(false);
    expect(requiresShellOnWindows('claude')).toBe(false); // bare name → no extension
  });
});
