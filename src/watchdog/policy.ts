/**
 * Pure functions for the watchdog state machine. Kept here so they can be
 * unit-tested without spawning real processes or mocking fs/network.
 */

const BACKOFF_LADDER_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_BACKOFF_MS = 30000;

/**
 * Backoff delay before respawning after the Nth failed attempt (0-indexed).
 * Caps at 30s so a long-running broken state still retries occasionally.
 */
export function nextBackoff(attempt: number): number {
  if (attempt < 0) return BACKOFF_LADDER_MS[0];
  if (attempt >= BACKOFF_LADDER_MS.length) return MAX_BACKOFF_MS;
  return BACKOFF_LADDER_MS[attempt];
}

export interface RespawnState {
  /** True once /v1/health has returned 200 at least once for the current daemon process. */
  everHealthy: boolean;
  /** Timestamps (ms epoch) of every respawn within the rolling window. */
  respawnTimestamps: number[];
  /** "now" injected for testability. Defaults to Date.now() when absent. */
  now?: number;
}

export type RespawnDecision =
  | { respawn: true; reason: 'runtime-crash' }
  | { respawn: false; reason: 'startup-failure' | 'gave-up' };

const RESPAWN_WINDOW_MS = 60_000;
const MAX_RESPAWNS_IN_WINDOW = 5;

/**
 * Decide whether to respawn after the daemon child exited.
 *
 * - If `everHealthy` is false, the daemon never reached /health 200 → treat
 *   as a startup failure (bad config, port-in-use). Do not loop.
 * - If 5+ respawns happened in the last 60s, give up — something is broken
 *   that won't self-resolve.
 * - Otherwise → respawn.
 */
export function shouldRespawn(state: RespawnState): RespawnDecision {
  if (!state.everHealthy) {
    return { respawn: false, reason: 'startup-failure' };
  }
  const now = state.now ?? Date.now();
  const recent = state.respawnTimestamps.filter((ts) => now - ts < RESPAWN_WINDOW_MS);
  if (recent.length >= MAX_RESPAWNS_IN_WINDOW) {
    return { respawn: false, reason: 'gave-up' };
  }
  return { respawn: true, reason: 'runtime-crash' };
}

export const RESPAWN_LIMITS = {
  windowMs: RESPAWN_WINDOW_MS,
  maxInWindow: MAX_RESPAWNS_IN_WINDOW,
} as const;
