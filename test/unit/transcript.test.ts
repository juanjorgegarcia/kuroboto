import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFirstUserMessage, readLastAssistantText } from '../../src/daemon/transcript.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-transcript-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeJsonl(name: string, lines: unknown[]): Promise<string> {
  const file = path.join(tmpDir, name);
  const body = lines.map((l) => JSON.stringify(l)).join('\n');
  await fsp.writeFile(file, body);
  return file;
}

describe('readFirstUserMessage', () => {
  it('returns text from a normal user-led JSONL', async () => {
    const file = await writeJsonl('t1.jsonl', [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi back' },
    ]);
    expect(await readFirstUserMessage(file)).toBe('hello there');
  });

  it('skips system-role lines and returns first user', async () => {
    const file = await writeJsonl('t2.jsonl', [
      { role: 'system', content: 'system intro' },
      { role: 'user', content: 'fix the bot UX' },
      { role: 'user', content: 'second one' },
    ]);
    expect(await readFirstUserMessage(file)).toBe('fix the bot UX');
  });

  it('returns null when file is missing', async () => {
    expect(await readFirstUserMessage(path.join(tmpDir, 'missing.jsonl'))).toBeNull();
  });

  it('skips malformed JSONL lines and returns first valid user', async () => {
    const file = path.join(tmpDir, 'mixed.jsonl');
    await fsp.writeFile(
      file,
      [
        '{not json at all',
        JSON.stringify({ role: 'system', content: 'sys' }),
        'garbage',
        JSON.stringify({ role: 'user', content: 'real first' }),
      ].join('\n'),
    );
    expect(await readFirstUserMessage(file)).toBe('real first');
  });

  it('extracts text from content blocks array', async () => {
    const file = await writeJsonl('blocks.jsonl', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'block one' },
          { type: 'text', text: 'block two' },
        ],
      },
    ]);
    expect(await readFirstUserMessage(file)).toBe('block one\nblock two');
  });

  it('returns null on empty user content', async () => {
    const file = await writeJsonl('empty.jsonl', [
      { role: 'user', content: '' },
      { role: 'user', content: 'second' },
    ]);
    expect(await readFirstUserMessage(file)).toBe('second');
  });
});

describe('readLastAssistantText', () => {
  it('returns text from latest assistant with text + tool_use blocks', async () => {
    const file = await writeJsonl('a1.jsonl', [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run a command' },
          { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    ]);
    expect(await readLastAssistantText(file)).toBe('I will run a command');
  });

  it('falls back to previous assistant when latest has only tool_use blocks', async () => {
    const file = await writeJsonl('a2.jsonl', [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'first thoughts' },
      { role: 'user', content: 'tool result' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'y', name: 'Bash', input: {} }],
      },
    ]);
    expect(await readLastAssistantText(file)).toBe('first thoughts');
  });

  it('returns null when there is no assistant message', async () => {
    const file = await writeJsonl('a3.jsonl', [{ role: 'user', content: 'just user' }]);
    expect(await readLastAssistantText(file)).toBeNull();
  });

  it('returns null on empty file', async () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    await fsp.writeFile(file, '');
    expect(await readLastAssistantText(file)).toBeNull();
  });

  it('returns null on missing file', async () => {
    expect(await readLastAssistantText(path.join(tmpDir, 'nope.jsonl'))).toBeNull();
  });
});
