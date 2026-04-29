import path from 'node:path';
import type { ChannelContext } from '../channels/Channel.js';
import type { InjectClients } from './injectClients.js';
import type { SleepingSnapshot } from './sleeping.js';

export interface TopicContextDeps {
  injectClients: InjectClients;
  sleepingSnap: SleepingSnapshot;
}

/**
 * Derive the routing context for an inbound hook payload. Priority:
 *   1. cwd matches an active sleep worktree → that sleep slug (with 💤)
 *   2. session is bound to a registered CLI client → that slug
 *   3. cwd matches a registered CLI client → that slug (late-bind path)
 *   4. otherwise → bare session_id (direct `claude`, no kuroboto wrapper)
 * Falls through to the kuroboto-system topic if nothing identifies the
 * source (handled inside the channel via `pickTopicKey`).
 */
export function topicContextFromHook(
  payload: { cwd?: string; session_id: string },
  deps: TopicContextDeps,
): ChannelContext {
  if (payload.cwd) {
    const sleep = deps.sleepingSnap.active.find((s) => samePath(payload.cwd!, s.worktreePath));
    if (sleep) return { slug: sleep.slug, isSleep: true };
  }
  const bound = deps.injectClients.lookupBySession(payload.session_id);
  if (bound) return { slug: bound.slug };
  if (payload.cwd) {
    for (const client of deps.injectClients.list()) {
      if (samePath(client.cwd, payload.cwd)) return { slug: client.slug };
    }
  }
  return {
    sessionId: payload.session_id,
    cwdBasename: cwdBasename(payload.cwd),
  };
}

export function topicContextForSleep(slug: string): ChannelContext {
  return { slug, isSleep: true };
}

export function topicContextSystem(): ChannelContext {
  return { system: true };
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function cwdBasename(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1];
}
