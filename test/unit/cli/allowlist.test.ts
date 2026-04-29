import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureIO } from '../../helpers/cliHarness.js';
import { allowlistList, allowlistExport } from '../../../src/cli/allowlist.js';

describe('cli/allowlist', () => {
  let io: ReturnType<typeof captureIO>;
  let tmpDir: string;

  beforeEach(async () => {
    io = captureIO();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-cli-allowlist-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSettings(content: string): Promise<void> {
    await fsp.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, '.claude', 'settings.local.json'), content);
  }

  describe('list', () => {
    it('settings missing: prints placeholder, exits 0', async () => {
      await allowlistList(tmpDir);
      expect(io.out()).toContain('(nenhum .claude/settings.local.json em');
      expect(io.out()).toContain(tmpDir);
    });

    it('allow array empty: prints "(allowlist vazia)"', async () => {
      await writeSettings(JSON.stringify({ permissions: { allow: [] } }));
      await allowlistList(tmpDir);
      expect(io.out()).toContain('(allowlist vazia)');
    });

    it('with entries: prints header + one bullet per matcher', async () => {
      await writeSettings(
        JSON.stringify({
          permissions: { allow: ['Bash(npm install:*)', 'Edit'] },
        }),
      );
      await allowlistList(tmpDir);
      const out = io.out();
      expect(out).toContain('allowlist em');
      expect(out).toContain('settings.local.json');
      expect(out).toContain('Bash(npm install:*)');
      expect(out).toContain('Edit');
    });

    it('malformed JSON: rejects (caller wraps to exit 1)', async () => {
      await writeSettings('not-json');
      await expect(allowlistList(tmpDir)).rejects.toThrow();
    });
  });

  describe('export', () => {
    it('settings missing: emits "{}" so machine readers see empty object', async () => {
      await allowlistExport(tmpDir);
      expect(io.stdout.join('').trim()).toBe('{}');
    });

    it('with settings: emits pretty-printed JSON of the parsed file', async () => {
      const settings = {
        permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
        env: { FOO: 'bar' },
      };
      await writeSettings(JSON.stringify(settings));
      await allowlistExport(tmpDir);
      const printed = JSON.parse(io.stdout.join('').trim());
      expect(printed).toEqual(settings);
    });
  });
});
