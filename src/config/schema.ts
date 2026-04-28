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
  strategy: z.enum(['tmux']).optional(),
  session: z.string().optional(),
});

export const PolicyConfig = z.object({
  permissionTimeoutMs: z.number().int().min(1000),
  notifyDelayMs: z.number().int().min(0).default(60_000),
  permissionMatchers: z.array(z.string()).default(['Bash', 'Edit', 'Write']),
  failOpen: z.boolean(),
});

export const Config = z.object({
  channel: ChannelConfig,
  daemon: DaemonConfig,
  inject: InjectConfig,
  policy: PolicyConfig,
});

export type ConfigT = z.infer<typeof Config>;
export type ChannelConfigT = z.infer<typeof ChannelConfig>;
