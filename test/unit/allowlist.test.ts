import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { computeAllowMatcher, addProjectAllow } from '../../src/daemon/allowlist.js';

describe('computeAllowMatcher', () => {
  it('Bash tight: 2 primeiros tokens + glob', () => {
    expect(computeAllowMatcher('Bash', { command: 'npm install lodash' }, 'tight'))
      .toBe('Bash(npm install:*)');
  });
  it('Bash tight: 1 token só vira Bash(token:*)', () => {
    expect(computeAllowMatcher('Bash', { command: 'ls' }, 'tight'))
      .toBe('Bash(ls:*)');
  });
  it('Bash permissive: só primeiro token', () => {
    expect(computeAllowMatcher('Bash', { command: 'npm install lodash' }, 'permissive'))
      .toBe('Bash(npm:*)');
  });
  it('Bash sem command: fallback toolname puro', () => {
    expect(computeAllowMatcher('Bash', {}, 'tight')).toBe('Bash');
  });
  it('Edit / Write: toolname puro', () => {
    expect(computeAllowMatcher('Edit', { file_path: '/a.ts' }, 'tight')).toBe('Edit');
    expect(computeAllowMatcher('Write', { file_path: '/a.ts' }, 'permissive')).toBe('Write');
  });
  it('Tool desconhecido: toolname puro', () => {
    expect(computeAllowMatcher('WebFetch', { url: 'x' }, 'tight')).toBe('WebFetch');
  });
});

describe('addProjectAllow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-allowlist-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('cria .claude/settings.local.json se não existe', async () => {
    await addProjectAllow(tmpDir, 'Bash(npm install:*)');
    const raw = await fsp.readFile(path.join(tmpDir, '.claude', 'settings.local.json'), 'utf-8');
    const json = JSON.parse(raw);
    expect(json.permissions.allow).toEqual(['Bash(npm install:*)']);
  });

  it('merge sem duplicar', async () => {
    const file = path.join(tmpDir, '.claude', 'settings.local.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ permissions: { allow: ['Edit'] } }));
    await addProjectAllow(tmpDir, 'Edit');
    await addProjectAllow(tmpDir, 'Bash(ls:*)');
    const json = JSON.parse(await fsp.readFile(file, 'utf-8'));
    expect(json.permissions.allow).toEqual(['Edit', 'Bash(ls:*)']);
  });

  it('preserva campos não-permissions do JSON existente', async () => {
    const file = path.join(tmpDir, '.claude', 'settings.local.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ env: { FOO: 'bar' }, permissions: { deny: ['Bash(rm:*)'] } }));
    await addProjectAllow(tmpDir, 'Edit');
    const json = JSON.parse(await fsp.readFile(file, 'utf-8'));
    expect(json.env).toEqual({ FOO: 'bar' });
    expect(json.permissions.deny).toEqual(['Bash(rm:*)']);
    expect(json.permissions.allow).toEqual(['Edit']);
  });
});
