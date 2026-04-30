/**
 * Coverage for Windows-specific spawn-resolution helpers. `isCmdOrBat` is
 * pure and runs on every OS so the .cmd-handling logic is exercised on
 * the full CI matrix; the platform-conditional `requiresShellOnWindows`
 * and the `where claude` resolver get the conditional treatment.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveClaudeExecutable,
  requiresShellOnWindows,
  isCmdOrBat,
  ClaudeCmdInstallUnsupportedError,
} from '../../src/core/claudeExe.js';

describe('isCmdOrBat (pure suffix check, OS-agnostic)', () => {
  it('returns true for .cmd / .CMD / .bat / .BAT regardless of OS', () => {
    expect(isCmdOrBat('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd')).toBe(true);
    expect(isCmdOrBat('C:\\path\\claude.CMD')).toBe(true);
    expect(isCmdOrBat('C:\\path\\claude.bat')).toBe(true);
    expect(isCmdOrBat('/posix/style/claude.cmd')).toBe(true); // suffix-based, not OS-based
  });

  it('returns false for .exe / extension-less / unrelated suffixes', () => {
    expect(isCmdOrBat('C:\\Users\\x\\.local\\bin\\claude.exe')).toBe(false);
    expect(isCmdOrBat('claude')).toBe(false);
    expect(isCmdOrBat('/usr/local/bin/claude')).toBe(false);
    expect(isCmdOrBat('claude.cmd.bak')).toBe(false); // not exact suffix
  });
});

describe('resolveClaudeExecutable', () => {
  it("returns 'claude' verbatim on POSIX", () => {
    if (process.platform === 'win32') return; // skip on Windows runners
    expect(resolveClaudeExecutable()).toBe('claude');
  });

  it('returns either an absolute path or fallback string on Windows', () => {
    if (process.platform !== 'win32') return; // skip on POSIX
    const result = resolveClaudeExecutable();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('requiresShellOnWindows (platform-conditional wrapper)', () => {
  it('always returns false on POSIX regardless of extension', () => {
    if (process.platform === 'win32') return;
    expect(requiresShellOnWindows('claude')).toBe(false);
    expect(requiresShellOnWindows('/path/to/claude.cmd')).toBe(false);
    expect(requiresShellOnWindows('C:\\path\\to\\claude.cmd')).toBe(false);
  });

  it('matches isCmdOrBat on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(requiresShellOnWindows('C:\\path\\claude.cmd')).toBe(true);
    expect(requiresShellOnWindows('C:\\path\\claude.exe')).toBe(false);
  });
});

describe('ClaudeCmdInstallUnsupportedError', () => {
  it('carries the resolved path and a message pointing at the binary installer', () => {
    const err = new ClaudeCmdInstallUnsupportedError('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd');
    expect(err.resolvedPath).toBe('C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd');
    expect(err.message).toContain('claude.cmd');
    expect(err.message).toContain('binary installer');
    expect(err.name).toBe('ClaudeCmdInstallUnsupportedError');
  });
});
