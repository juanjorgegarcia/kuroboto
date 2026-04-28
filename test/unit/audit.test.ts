import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('audit log', () => {
  let tmpDir: string;
  let auditFile: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-audit-'));
    auditFile = path.join(tmpDir, 'audit.jsonl');
    vi.resetModules();
    vi.doMock('../../src/config/paths.js', async () => {
      const real = await vi.importActual<typeof import('../../src/config/paths.js')>(
        '../../src/config/paths.js',
      );
      return { ...real, AUDIT_FILE: auditFile, CONFIG_DIR: tmpDir };
    });
  });
  afterEach(async () => {
    vi.doUnmock('../../src/config/paths.js');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('appendAudit writes a JSONL line', async () => {
    const { appendAudit } = await import('../../src/daemon/audit.js');
    await appendAudit({
      ts: '2026-04-28T10:00:00.000Z',
      requestId: 'req-1',
      tool: 'Bash',
      cwd: '/x',
      decision: 'allow',
      reason: null,
      source: 'telegram',
      remember: false,
    });
    const raw = await fsp.readFile(auditFile, 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toMatchObject({ requestId: 'req-1', decision: 'allow' });
  });

  it('appendAudit appends multiple lines without overwriting', async () => {
    const { appendAudit } = await import('../../src/daemon/audit.js');
    await appendAudit({ ts: 't1', requestId: 'r1', tool: 'Bash', cwd: '/x', decision: 'allow', reason: null, source: 'telegram', remember: false });
    await appendAudit({ ts: 't2', requestId: 'r2', tool: 'Edit', cwd: '/x', decision: 'deny', reason: 'no', source: 'telegram', remember: false });
    const lines = (await fsp.readFile(auditFile, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).requestId).toBe('r1');
    expect(JSON.parse(lines[1]).requestId).toBe('r2');
  });

  it('readAudit returns parsed entries respecting filters', async () => {
    const { appendAudit, readAudit } = await import('../../src/daemon/audit.js');
    const now = Date.now();
    await appendAudit({ ts: new Date(now - 3600_000).toISOString(), requestId: 'old', tool: 'Bash', cwd: '/a', decision: 'allow', reason: null, source: 'telegram', remember: false });
    await appendAudit({ ts: new Date(now - 60_000).toISOString(),   requestId: 'mid', tool: 'Bash', cwd: '/a', decision: 'deny',  reason: null, source: 'telegram', remember: false });
    await appendAudit({ ts: new Date(now).toISOString(),            requestId: 'new', tool: 'Edit', cwd: '/b', decision: 'allow', reason: null, source: 'telegram', remember: false });

    const all = await readAudit({});
    expect(all.map((e) => e.requestId)).toEqual(['old', 'mid', 'new']);

    const last5min = await readAudit({ sinceMs: 5 * 60 * 1000 });
    expect(last5min.map((e) => e.requestId)).toEqual(['mid', 'new']);

    const onlyB = await readAudit({ cwd: '/b' });
    expect(onlyB.map((e) => e.requestId)).toEqual(['new']);
  });

  it('readAudit returns [] when file does not exist', async () => {
    const { readAudit } = await import('../../src/daemon/audit.js');
    expect(await readAudit({})).toEqual([]);
  });

  it('readAudit skips malformed lines without throwing', async () => {
    await fsp.writeFile(auditFile, '{"ts":"t","requestId":"ok","tool":"Bash","cwd":null,"decision":"allow","reason":null,"source":"telegram","remember":false}\nthis is garbage\n');
    const { readAudit } = await import('../../src/daemon/audit.js');
    const entries = await readAudit({});
    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe('ok');
  });
});
