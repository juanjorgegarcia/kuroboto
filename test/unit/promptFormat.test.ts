import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { formatPermissionPrompt, formatNotification } from '../../src/daemon/promptFormat.js';
import type { PreToolUsePayload, NotificationPayload } from '../../src/core/types.js';
import type { SleepingSnapshot } from '../../src/daemon/sleeping.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-promptfmt-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeTranscript(name: string, lines: unknown[]): Promise<string> {
  const file = path.join(tmpDir, name);
  await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

const idleSleep: SleepingSnapshot = { active: false };

function permissionPayload(over: Partial<PreToolUsePayload> = {}): PreToolUsePayload {
  return {
    session_id: 's1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    cwd: '/x/kuroboto',
    ...over,
  };
}

function notificationPayload(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    session_id: 's1',
    hook_event_name: 'Notification',
    cwd: '/x/kuroboto',
    ...over,
  };
}

describe('formatPermissionPrompt — interactive', () => {
  it('all data present → host / folder / first-user / 💭 intent / body', async () => {
    const transcript = await writeTranscript('a.jsonl', [
      { role: 'user', content: 'vamos melhorar a UX do bot' },
      { role: 'assistant', content: 'Vou limpar os arquivos temporários antes do deploy' },
    ]);
    const out = await formatPermissionPrompt(
      permissionPayload({ transcript_path: transcript, tool_input: { command: 'rm -rf /tmp/foo' } }),
      { hostname: 'win-juan', sleeping: idleSleep },
    );
    expect(out).toBe(
      '[win-juan / kuroboto / "vamos melhorar a UX do bot"]\n' +
        '💭 Vou limpar os arquivos temporários antes do deploy\n\n' +
        'Pode rodar?\nBash: rm -rf /tmp/foo',
    );
  });

  it('no transcript path → host / folder, no first-user, no intent', async () => {
    const out = await formatPermissionPrompt(
      permissionPayload({ tool_input: { command: 'ls' } }),
      { hostname: 'win-juan', sleeping: idleSleep },
    );
    expect(out).toBe('[win-juan / kuroboto]\n\nPode rodar?\nBash: ls');
  });

  it('no cwd → host alone', async () => {
    const out = await formatPermissionPrompt(
      permissionPayload({ cwd: undefined, tool_input: { command: 'ls' } }),
      { hostname: 'win-juan', sleeping: idleSleep },
    );
    expect(out).toBe('[win-juan]\n\nPode rodar?\nBash: ls');
  });

  it('transcript missing on disk → header omits "..." segment, no intent', async () => {
    const out = await formatPermissionPrompt(
      permissionPayload({
        transcript_path: path.join(tmpDir, 'nope.jsonl'),
        tool_input: { command: 'ls' },
      }),
      { hostname: 'win-juan', sleeping: idleSleep },
    );
    expect(out).toBe('[win-juan / kuroboto]\n\nPode rodar?\nBash: ls');
  });

  it('first-user-message > 60 chars → truncated with …', async () => {
    const long = 'a'.repeat(80);
    const transcript = await writeTranscript('long.jsonl', [{ role: 'user', content: long }]);
    const out = await formatPermissionPrompt(
      permissionPayload({ transcript_path: transcript, tool_input: { command: 'ls' } }),
      { hostname: 'h', sleeping: idleSleep },
    );
    expect(out).toContain('"' + 'a'.repeat(59) + '…"');
  });

  it('assistant-text > 200 chars → truncated with …', async () => {
    const long = 'b'.repeat(250);
    const transcript = await writeTranscript('longa.jsonl', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: long },
    ]);
    const out = await formatPermissionPrompt(
      permissionPayload({ transcript_path: transcript, tool_input: { command: 'ls' } }),
      { hostname: 'h', sleeping: idleSleep },
    );
    expect(out).toContain('💭 ' + 'b'.repeat(199) + '…');
  });
});

describe('formatPermissionPrompt — sleep mode', () => {
  it('cwd matches sleeping worktree → host / 💤 slug-no-suffix, skips first-user', async () => {
    const transcript = await writeTranscript('sleep.jsonl', [
      { role: 'user', content: 'PLAN_INTRO blah blah do this thing' },
      { role: 'assistant', content: 'Will start with step 1' },
    ]);
    const sleeping: SleepingSnapshot = {
      active: true,
      slug: 'fix-the-bot-ux-abc123',
      branch: 'sleep/fix-the-bot-ux-abc123',
      worktreePath: '/work/fix-the-bot-ux-abc123',
      startedAt: 1,
      expectedEndAt: 2,
    };
    const out = await formatPermissionPrompt(
      permissionPayload({
        transcript_path: transcript,
        cwd: '/work/fix-the-bot-ux-abc123',
        tool_input: { command: 'ls' },
      }),
      { hostname: 'win-juan', sleeping },
    );
    expect(out).toBe(
      '[win-juan / 💤 fix-the-bot-ux]\n' +
        '💭 Will start with step 1\n\n' +
        'Pode rodar?\nBash: ls',
    );
  });

  it('cwd does NOT match worktreePath while sleeping → treated as interactive', async () => {
    const sleeping: SleepingSnapshot = {
      active: true,
      slug: 'foo-abc123',
      branch: 'sleep/foo-abc123',
      worktreePath: '/work/foo-abc123',
      startedAt: 1,
      expectedEndAt: 2,
    };
    const out = await formatPermissionPrompt(
      permissionPayload({ cwd: '/x/elsewhere', tool_input: { command: 'ls' } }),
      { hostname: 'h', sleeping },
    );
    expect(out).toBe('[h / elsewhere]\n\nPode rodar?\nBash: ls');
  });
});

describe('formatNotification', () => {
  it('default message uses the same header + intent', async () => {
    const transcript = await writeTranscript('n.jsonl', [
      { role: 'user', content: 'vamos melhorar a UX do bot' },
      { role: 'assistant', content: 'Aguardando confirmação antes de rodar a migração' },
    ]);
    const out = await formatNotification(
      notificationPayload({ transcript_path: transcript }),
      { hostname: 'win-juan', sleeping: idleSleep },
    );
    expect(out).toBe(
      '[win-juan / kuroboto / "vamos melhorar a UX do bot"]\n' +
        '💭 Aguardando confirmação antes de rodar a migração\n\n' +
        'Claude Code precisa de atenção.',
    );
  });

  it('custom message replaces body but keeps header', async () => {
    const out = await formatNotification(
      notificationPayload({ message: 'a custom message' }),
      { hostname: 'h', sleeping: idleSleep },
    );
    expect(out).toBe('[h / kuroboto]\n\na custom message');
  });
});
