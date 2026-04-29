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
  if (member.status !== 'administrator') {
    throw new ChannelError(
      `forumMode requires the bot to be an administrator of chat ${chatId} ` +
        `(current status: ${member.status}). Open the supergroup settings ` +
        `→ Administrators, add the bot, and enable "Manage Topics".`,
    );
  }
  if (member.can_manage_topics !== true) {
    throw new ChannelError(
      `forumMode requires the bot's "Manage Topics" admin permission to be ` +
        `granted in chat ${chatId}. Open the supergroup settings → ` +
        `Administrators → the bot, and toggle "Manage Topics" on.`,
    );
  }
}
