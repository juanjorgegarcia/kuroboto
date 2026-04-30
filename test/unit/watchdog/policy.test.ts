import { describe, it, expect } from 'vitest';
import { nextBackoff, shouldRespawn, RESPAWN_LIMITS } from '../../../src/watchdog/policy.js';

describe('watchdog/policy nextBackoff', () => {
  it('follows the documented exponential ladder for attempts 0..6', () => {
    const got = [0, 1, 2, 3, 4, 5, 6].map((a) => nextBackoff(a));
    expect(got).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('clamps far-future attempts at the 30s ceiling', () => {
    expect(nextBackoff(50)).toBe(30000);
    expect(nextBackoff(1_000_000)).toBe(30000);
  });

  it('treats negative attempts as the first attempt (defensive)', () => {
    expect(nextBackoff(-1)).toBe(1000);
  });
});

describe('watchdog/policy shouldRespawn', () => {
  it('refuses to respawn when /health never returned 200 — that is a startup failure', () => {
    const decision = shouldRespawn({ everHealthy: false, respawnTimestamps: [] });
    expect(decision).toEqual({ respawn: false, reason: 'startup-failure' });
  });

  it(`gives up after ${RESPAWN_LIMITS.maxInWindow} respawns in the rolling 60s window`, () => {
    const now = 1_000_000;
    const tooMany = [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000];
    const decision = shouldRespawn({
      everHealthy: true,
      respawnTimestamps: tooMany,
      now,
    });
    expect(decision).toEqual({ respawn: false, reason: 'gave-up' });
  });

  it('counts only respawns inside the window — older ones drop off', () => {
    const now = 1_000_000;
    const fourRecentPlusOldOnes = [
      now - 120_000,
      now - 90_000,
      now - 50_000,
      now - 40_000,
      now - 30_000,
      now - 20_000,
    ];
    const decision = shouldRespawn({
      everHealthy: true,
      respawnTimestamps: fourRecentPlusOldOnes,
      now,
    });
    expect(decision).toEqual({ respawn: true, reason: 'runtime-crash' });
  });

  it('respawns on the happy path: healthy at least once, no recent burst', () => {
    const decision = shouldRespawn({ everHealthy: true, respawnTimestamps: [], now: 1_000_000 });
    expect(decision).toEqual({ respawn: true, reason: 'runtime-crash' });
  });

  it('respawns when the caller has reset the timestamp list — encodes the "healthy ≥30s resets the counter" contract', () => {
    // The watchdog is responsible for clearing respawnTimestamps after the
    // daemon stays healthy ≥30s. From the policy's perspective, an empty
    // list means "fresh budget" regardless of how many crashes happened
    // historically.
    const decision = shouldRespawn({
      everHealthy: true,
      respawnTimestamps: [],
      now: 1_000_000,
    });
    expect(decision).toEqual({ respawn: true, reason: 'runtime-crash' });
  });
});
