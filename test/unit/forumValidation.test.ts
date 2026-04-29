import { describe, it, expect } from 'vitest';
import { validateBotPermissions } from '../../src/channels/telegram/forumValidation.js';

interface MemberShape {
  status: string;
  can_manage_topics?: boolean;
}

function fakeApi(opts: {
  me?: { id: number };
  meErr?: Error;
  member?: MemberShape;
  memberErr?: Error;
}) {
  return {
    async getMe(): Promise<{ id: number }> {
      if (opts.meErr) throw opts.meErr;
      return opts.me ?? { id: 42 };
    },
    async getChatMember(): Promise<MemberShape> {
      if (opts.memberErr) throw opts.memberErr;
      return opts.member ?? { status: 'administrator', can_manage_topics: true };
    },
  };
}

describe('validateBotPermissions', () => {
  it('resolves when bot is admin with can_manage_topics', async () => {
    const api = fakeApi({});
    await expect(validateBotPermissions(api, -100123)).resolves.toBeUndefined();
  });

  it('throws when status is not administrator', async () => {
    const api = fakeApi({ member: { status: 'member' } });
    await expect(validateBotPermissions(api, -100123)).rejects.toThrow(
      /not.*administrator|administrator.*chat/i,
    );
  });

  it('throws when admin but missing can_manage_topics', async () => {
    const api = fakeApi({ member: { status: 'administrator', can_manage_topics: false } });
    await expect(validateBotPermissions(api, -100123)).rejects.toThrow(
      /can_manage_topics|Manage Topics/i,
    );
  });

  it('throws when admin but can_manage_topics field is missing entirely', async () => {
    const api = fakeApi({ member: { status: 'administrator' } });
    await expect(validateBotPermissions(api, -100123)).rejects.toThrow(/Manage Topics/i);
  });

  it('wraps getMe errors with context', async () => {
    const api = fakeApi({ meErr: new Error('connect ECONNREFUSED') });
    await expect(validateBotPermissions(api, -100123)).rejects.toThrow(
      /getMe error.*ECONNREFUSED/,
    );
  });

  it('wraps getChatMember errors with context', async () => {
    const api = fakeApi({ memberErr: new Error('chat not found') });
    await expect(validateBotPermissions(api, -100123)).rejects.toThrow(
      /getChatMember error.*chat not found/,
    );
  });
});
