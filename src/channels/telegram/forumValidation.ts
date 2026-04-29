import { ChannelError } from '../../core/errors.js';

export interface ForumValidationApi {
  getMe(): Promise<{ id: number }>;
  getChatMember(
    chatId: number,
    userId: number,
  ): Promise<{ status: string; can_manage_topics?: boolean }>;
}

/**
 * Verifies the bot can manage topics in the configured supergroup. Called on
 * daemon startup when `channel.forumMode === true` so we fail fast instead
 * of waiting for the first sendMessage to 400.
 */
export async function validateBotPermissions(
  api: ForumValidationApi,
  chatId: number,
): Promise<void> {
  let botId: number;
  try {
    const me = await api.getMe();
    botId = me.id;
  } catch (e) {
    throw new ChannelError(
      `forumMode validation failed — getMe error: ${(e as Error).message}`,
    );
  }
  let member: { status: string; can_manage_topics?: boolean };
  try {
    member = await api.getChatMember(chatId, botId);
  } catch (e) {
    throw new ChannelError(
      `forumMode validation failed — getChatMember error: ${(e as Error).message}`,
    );
  }
  // 'creator' = group owner, also has full topic-management capability per
  // Telegram API docs. Only reject when the bot is a plain member / left / etc.
  if (member.status !== 'administrator' && member.status !== 'creator') {
    throw new ChannelError(
      `forumMode requires the bot to be an administrator of chat ${chatId} ` +
        `(current status: ${member.status}). Open the supergroup settings ` +
        `→ Administrators, add the bot, and enable "Manage Topics".`,
    );
  }
  // Group creators implicitly have all permissions; only check the explicit
  // can_manage_topics flag for non-creator administrators.
  if (member.status === 'administrator' && member.can_manage_topics !== true) {
    throw new ChannelError(
      `forumMode requires the bot's "Manage Topics" admin permission to be ` +
        `granted in chat ${chatId}. Open the supergroup settings → ` +
        `Administrators → the bot, and toggle "Manage Topics" on.`,
    );
  }
}
