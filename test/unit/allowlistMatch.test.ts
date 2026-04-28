import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { matchPattern, loadAllowlist, matchAny } from '../../src/daemon/allowlistMatch.js';

describe('matchPattern', () => {
  describe('plain tool name (any call)', () => {
    it('Bash matches any Bash call', () => {
      expect(matchPattern('Bash', { command: 'rm -rf /' }, 'Bash')).toBe(true);
    });
    it('Edit matches any Edit call', () => {
      expect(matchPattern('Edit', { file_path: '/x' }, 'Edit')).toBe(true);
    });
    it('Bash does not match an Edit pattern', () => {
      expect(matchPattern('Bash', { command: 'ls' }, 'Edit')).toBe(false);
    });
  });

  describe('Bash with prefix:* glob', () => {
    it('first token match', () => {
      expect(matchPattern('Bash', { command: 'npm install lodash' }, 'Bash(npm:*)')).toBe(true);
    });
    it('first two tokens match', () => {
      expect(matchPattern('Bash', { command: 'npm install lodash' }, 'Bash(npm install:*)')).toBe(true);
    });
    it('mismatch first token', () => {
      expect(matchPattern('Bash', { command: 'pnpm install' }, 'Bash(npm:*)')).toBe(false);
    });
    it('mismatch second token', () => {
      expect(matchPattern('Bash', { command: 'npm test' }, 'Bash(npm install:*)')).toBe(false);
    });
    it('does not require args after prefix', () => {
      // Bash(npm:*) means "first token is npm, anything (or nothing) after"
      expect(matchPattern('Bash', { command: 'npm' }, 'Bash(npm:*)')).toBe(true);
    });
  });

  describe('Bash exact match (no :*)', () => {
    it('exact command matches', () => {
      expect(matchPattern('Bash', { command: 'npm install foo' }, 'Bash(npm install foo)')).toBe(true);
    });
    it('different command does not match', () => {
      expect(matchPattern('Bash', { command: 'npm install foo bar' }, 'Bash(npm install foo)')).toBe(false);
    });
  });

  describe('Edit/Write/Read with file_path', () => {
    it('exact path match', () => {
      expect(matchPattern('Edit', { file_path: '/src/a.ts' }, 'Edit(/src/a.ts)')).toBe(true);
    });
    it('glob match', () => {
      expect(matchPattern('Edit', { file_path: '/src/foo/bar.ts' }, 'Edit(/src/**)')).toBe(true);
    });
    it('glob mismatch', () => {
      expect(matchPattern('Edit', { file_path: '/other/file.ts' }, 'Edit(/src/**)')).toBe(false);
    });
    it('Read with double-slash absolute', () => {
      expect(matchPattern('Read', { file_path: '/tmp/x' }, 'Read(//tmp/**)')).toBe(true);
    });
    it('Write glob match', () => {
      expect(matchPattern('Write', { file_path: '/log/a.txt' }, 'Write(/log/**)')).toBe(true);
    });
  });

  describe('falls through (out of scope grammar)', () => {
    it('WebFetch domain pattern is not honored', () => {
      expect(matchPattern('WebFetch', { url: 'https://example.com' }, 'WebFetch(domain:example.com)')).toBe(false);
    });
    it('unknown tool with parens does not match', () => {
      expect(matchPattern('XYZ', { whatever: 1 }, 'XYZ(foo)')).toBe(false);
    });
  });

  describe('input edge cases', () => {
    it('Bash with no command falls back to false for parameterized pattern', () => {
      expect(matchPattern('Bash', {}, 'Bash(npm:*)')).toBe(false);
    });
    it('Bash with no command still matches plain "Bash"', () => {
      expect(matchPattern('Bash', {}, 'Bash')).toBe(true);
    });
    it('Edit with no file_path does not match a path pattern', () => {
      expect(matchPattern('Edit', {}, 'Edit(/x)')).toBe(false);
    });
  });
});

describe('matchAny', () => {
  it('returns true if any pattern matches', () => {
    expect(matchAny('Bash', { command: 'npm install x' }, ['Edit', 'Bash(npm:*)', 'Read(/y/**)'])).toBe(true);
  });
  it('returns false if none match', () => {
    expect(matchAny('Bash', { command: 'rm -rf /' }, ['Edit', 'Bash(npm:*)'])).toBe(false);
  });
  it('returns false on empty list', () => {
    expect(matchAny('Bash', { command: 'x' }, [])).toBe(false);
  });
});

describe('loadAllowlist', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-allowmatch-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty arrays when directory has no .claude/settings.local.json', async () => {
    expect(await loadAllowlist(tmpDir)).toEqual({ allow: [], deny: [] });
  });

  it('reads allow + deny from settings.local.json', async () => {
    const file = path.join(tmpDir, '.claude', 'settings.local.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({
      permissions: { allow: ['Bash(npm:*)'], deny: ['Bash(rm:*)'] },
    }));
    expect(await loadAllowlist(tmpDir)).toEqual({
      allow: ['Bash(npm:*)'],
      deny: ['Bash(rm:*)'],
    });
  });

  it('returns empty when JSON is malformed', async () => {
    const file = path.join(tmpDir, '.claude', 'settings.local.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'not json {{{');
    expect(await loadAllowlist(tmpDir)).toEqual({ allow: [], deny: [] });
  });

  it('returns empty arrays when permissions key is missing', async () => {
    const file = path.join(tmpDir, '.claude', 'settings.local.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ env: { FOO: 'bar' } }));
    expect(await loadAllowlist(tmpDir)).toEqual({ allow: [], deny: [] });
  });
});
