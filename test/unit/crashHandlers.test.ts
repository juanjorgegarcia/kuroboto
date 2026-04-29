import { describe, it, expect } from 'vitest';
import { logCrashSync } from '../../src/daemon/crashHandlers.js';

interface Captured {
  appends: Array<{ file: string; data: string }>;
  mkdirs: string[];
  stderr: string[];
}

function captured(): Captured & {
  deps: Parameters<typeof logCrashSync>[3];
} {
  const c: Captured = { appends: [], mkdirs: [], stderr: [] };
  return {
    ...c,
    deps: {
      appendSync: (file, data) => {
        c.appends.push({ file, data });
      },
      mkdirSync: (dir) => {
        c.mkdirs.push(dir);
      },
      stderrWrite: (msg) => {
        c.stderr.push(msg);
      },
    },
  };
}

describe('crashHandlers/logCrashSync', () => {
  it('writes a timestamped entry with the error stack to the crash log', () => {
    const c = captured();
    const err = new Error('boom');
    logCrashSync('/tmp/crash.log', 'uncaughtException', err, c.deps);

    expect(c.appends).toHaveLength(1);
    expect(c.appends[0].file).toBe('/tmp/crash.log');
    const line = c.appends[0].data;
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z \[uncaughtException\] /);
    expect(line).toContain('boom');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('mirrors the crash to stderr so detached startup capture sees it', () => {
    const c = captured();
    logCrashSync('/tmp/crash.log', 'unhandledRejection', new Error('x'), c.deps);
    expect(c.stderr.some((s) => s.includes('[kuroboto daemon] unhandledRejection: '))).toBe(true);
  });

  it('mkdirs the parent directory before appending', () => {
    const c = captured();
    logCrashSync('/var/state/kuroboto/daemon.crash.log', 'uncaughtException', new Error('x'), c.deps);
    expect(c.mkdirs).toEqual(['/var/state/kuroboto']);
  });

  it('falls back to stderr when the append fails', () => {
    const c = captured();
    const failing: typeof c.deps = {
      ...c.deps,
      appendSync: () => {
        throw new Error('disk full');
      },
    };
    logCrashSync('/tmp/crash.log', 'uncaughtException', new Error('boom'), failing);
    expect(c.stderr.some((s) => s.includes('crash log write failed: disk full'))).toBe(true);
    expect(c.stderr.some((s) => s.includes('[kuroboto daemon] uncaughtException: '))).toBe(true);
  });

  it('handles non-Error throws by stringifying them', () => {
    const c = captured();
    logCrashSync('/tmp/crash.log', 'unhandledRejection', 'plain string reason', c.deps);
    expect(c.appends[0].data).toContain('plain string reason');
  });
});
