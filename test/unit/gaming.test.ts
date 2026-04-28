import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GamingState, parseDuration } from '../../src/daemon/gaming.js';

describe('parseDuration', () => {
  it('accepts seconds/minutes/hours', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(15 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
  });
  it('rejects invalid input', () => {
    for (const bad of ['', '15', '0s', '-5m', '15x', 'abc', '1.5m', ' 15m ']) {
      expect(() => parseDuration(bad)).toThrow();
    }
  });
});

describe('GamingState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial: inactive, no until', () => {
    const g = new GamingState();
    expect(g.snapshot()).toEqual({ active: false, until: null });
  });

  it('arm() without duration: active, no timer', () => {
    const g = new GamingState();
    g.arm();
    expect(g.snapshot()).toEqual({ active: true, until: null });
    // No setTimeout was scheduled — advancing time doesn't flip it off.
    vi.advanceTimersByTime(1_000_000);
    expect(g.snapshot().active).toBe(true);
  });

  it('arm(50ms) flips off after the timeout', () => {
    const g = new GamingState();
    const start = Date.now();
    g.arm(50);
    expect(g.snapshot()).toEqual({ active: true, until: start + 50 });
    vi.advanceTimersByTime(49);
    expect(g.snapshot().active).toBe(true);
    vi.advanceTimersByTime(2);
    expect(g.snapshot()).toEqual({ active: false, until: null });
  });

  it('cancel() before timer clears it', () => {
    const g = new GamingState();
    g.arm(1_000_000);
    g.cancel();
    expect(g.snapshot()).toEqual({ active: false, until: null });
    vi.advanceTimersByTime(1_000_000);
    expect(g.snapshot().active).toBe(false);
  });

  it('arming twice cancels the first timer', () => {
    const g = new GamingState();
    const start = Date.now();
    g.arm(50);
    g.arm(200);
    expect(g.snapshot().until).toBe(start + 200);
    vi.advanceTimersByTime(60);
    // First timer would have fired by now — confirm it didn't
    expect(g.snapshot().active).toBe(true);
    vi.advanceTimersByTime(150);
    expect(g.snapshot().active).toBe(false);
  });

  it('rejects non-positive durations', () => {
    const g = new GamingState();
    expect(() => g.arm(0)).toThrow();
    expect(() => g.arm(-100)).toThrow();
  });

  it('cancel is idempotent', () => {
    const g = new GamingState();
    g.cancel();
    g.cancel();
    expect(g.snapshot()).toEqual({ active: false, until: null });
  });
});
