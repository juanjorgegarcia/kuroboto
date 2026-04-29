import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { captureIO } from '../../helpers/cliHarness.js';
import * as auditModule from '../../../src/daemon/audit.js';
import type { AuditEntry } from '../../../src/daemon/audit.js';

import { auditList, auditExport } from '../../../src/cli/audit.js';

function entry(o: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-04-28T10:00:00.000Z',
    requestId: 'r1',
    tool: 'Bash',
    cwd: '/x',
    decision: 'allow',
    reason: null,
    source: 'telegram',
    remember: false,
    ...o,
  };
}

describe('cli/audit', () => {
  let io: ReturnType<typeof captureIO>;
  let readSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    io = captureIO();
    readSpy = vi.spyOn(auditModule, 'readAudit');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('no opts: passes empty filter, prints one row per entry', async () => {
      readSpy.mockResolvedValue([
        entry({ requestId: 'r1', tool: 'Bash', cwd: '/x', decision: 'allow' }),
        entry({ requestId: 'r2', tool: 'Edit', cwd: '/y', decision: 'deny', reason: 'no' }),
      ]);
      await auditList({});
      expect(readSpy).toHaveBeenCalledWith({
        sinceMs: undefined,
        cwd: undefined,
        limit: undefined,
      });
      const out = io.out();
      expect(out).toContain('Bash');
      expect(out).toContain('Edit');
      expect(out).toContain('ALLOW');
      expect(out).toContain('DENY');
      expect(out).toContain('cwd=/x');
      expect(out).toContain('cwd=/y');
      expect(out).toContain('reason="no"');
    });

    it('empty: prints "(sem entradas)" placeholder', async () => {
      readSpy.mockResolvedValue([]);
      await auditList({});
      expect(io.out()).toContain('(sem entradas)');
    });

    it('--since 5m: translates to sinceMs=300_000', async () => {
      readSpy.mockResolvedValue([]);
      await auditList({ since: '5m' });
      expect(readSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sinceMs: 5 * 60_000 }),
      );
    });

    it('--cwd /some/path: forwarded as cwd filter', async () => {
      readSpy.mockResolvedValue([]);
      await auditList({ cwd: '/some/path' });
      expect(readSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/some/path' }),
      );
    });

    it('--limit 50: forwarded as numeric limit', async () => {
      readSpy.mockResolvedValue([]);
      await auditList({ limit: '50' });
      expect(readSpy).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });

    it('renders ALLOW+R for remember=true entries', async () => {
      readSpy.mockResolvedValue([entry({ decision: 'allow', remember: true })]);
      await auditList({});
      expect(io.out()).toContain('ALLOW+R');
    });
  });

  describe('export', () => {
    it('prints raw JSONL, one entry per line, machine-parseable', async () => {
      const a = entry({ requestId: 'r1', tool: 'Bash' });
      const b = entry({ requestId: 'r2', tool: 'Edit' });
      readSpy.mockResolvedValue([a, b]);
      await auditExport({});
      const out = io.stdout.join('');
      const lines = out.trim().split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ requestId: 'r1', tool: 'Bash' });
      expect(JSON.parse(lines[1]!)).toMatchObject({ requestId: 'r2', tool: 'Edit' });
    });
  });
});
