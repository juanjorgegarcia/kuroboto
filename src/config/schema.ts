import { z } from 'zod';

export const ChannelConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('telegram'),
    token: z.string().min(1),
    chatId: z.number(),
  }),
]);

export const DaemonConfig = z.object({
  port: z.number().int().min(1024).max(65535),
  authToken: z.string().length(64),
});

export const InjectConfig = z.object({
  enabled: z.boolean(),
  strategy: z.enum(['pty', 'tmux']).default('pty'),
  session: z.string().optional(),
  replyTimeoutMs: z.number().int().min(1000).default(7_200_000),
});

export const NotificationsConfig = z.object({
  desktop: z.boolean().default(false),
});

export const PolicyConfig = z.object({
  permissionTimeoutMs: z.number().int().min(1000),
  notifyDelayMs: z.number().int().min(0).default(60_000),
  permissionMatchers: z.array(z.string()).default(['Bash', 'Edit', 'Write']),
  rememberGranularity: z.enum(['tight', 'permissive']).default('tight'),
  gamingAlwaysAsk: z.array(z.string()).default([]),
  sleepMaxDurationMs: z.number().int().min(60_000).default(2 * 60 * 60 * 1000),
  sleepWorktreeDir: z.string().default('~/.kuroboto/worktrees'),
  failOpen: z.boolean(),
});

export const Config = z.object({
  channel: ChannelConfig,
  daemon: DaemonConfig,
  inject: InjectConfig,
  policy: PolicyConfig,
  notifications: NotificationsConfig.default({ desktop: false }),
});

export type ConfigT = z.infer<typeof Config>;
export type ChannelConfigT = z.infer<typeof ChannelConfig>;
