import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  humanizeDuration,
  formatCountdown,
  truncatePath,
  formatHumanReadable,
  formatJson,
  formatQuiet,
  type MergedStatus,
  type StatusData,
} from '../../src/cli/statusFormat.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeStatus(overrides: Partial<MergedStatus> = {}): MergedStatus {
  const now = Date.now();
  const data: StatusData = {
    daemon: {
      pid: 12345,
      uptimeSec: 2850,
      startedAt: new Date(now - 2850 * 1000).toISOString(),
      hostname: 'test-host',
      port: 47891,
    },
    pending: { permissions: 0, notifications: 0, replies: 0 },
    mode: 'here',
    gaming: { active: false, until: null },
    sleeping: { active: [], capacity: 6 },
    injectClients: [],
    topics: { forumMode: false, count: 0 },
  };
  return {
    configPath: '/home/user/.config/kuroboto/config.json',
    watchdog: null,
    daemonPid: 12345,
    daemonAlive: true,
    splitBrain: false,
    fetchResult: { ok: true, data },
    installedHooks: ['Notification', 'PreToolUse', 'Stop'],
    ...overrides,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

describe('humanizeDuration', () => {
  it('0ms → 0s', () => expect(humanizeDuration(0)).toBe('0s'));
  it('47000ms → 47s', () => expect(humanizeDuration(47_000)).toBe('47s'));
  it('2_850_000ms → 47m', () => expect(humanizeDuration(2_850_000)).toBe('47m'));
  it('8_100_000ms → 2h15m', () => expect(humanizeDuration(8_100_000)).toBe('2h15m'));
  it('90_000_000ms → 1d1h', () => expect(humanizeDuration(90_000_000)).toBe('1d1h'));
  it('3_600_000ms (1h exact) → 1h', () => expect(humanizeDuration(3_600_000)).toBe('1h'));
  it('86_400_000ms (1d exact) → 1d', () => expect(humanizeDuration(86_400_000)).toBe('1d'));
});

describe('formatCountdown', () => {
  // Mock the clock so Windows' coarse timer (~15ms) doesn't cause the 1s test
  // to land on diff=985ms → "0s" between Date.now() in the test and inside
  // formatCountdown.
  const NOW = 1_700_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('future 1s → "1s"', () => {
    expect(formatCountdown(NOW + 1_000)).toBe('1s');
  });
  it('future 90_000_000ms → "1d1h"', () => {
    expect(formatCountdown(NOW + 90_000_000)).toBe('1d1h');
  });
  it('past 5s → "(expirou há 5s)"', () => {
    expect(formatCountdown(NOW - 5_000)).toBe('(expirou há 5s)');
  });
  it('past 30_000_000ms → "(expirou há 8h20m)"', () => {
    expect(formatCountdown(NOW - 30_000_000)).toBe('(expirou há 8h20m)');
  });
});

describe('truncatePath', () => {
  it('short path returned unchanged', () => {
    expect(truncatePath('C:/short')).toBe('C:/short');
  });
  it('path > 60 chars gets truncated with leading …/', () => {
    const long = '/very/long/path/that/exceeds/the/sixty/character/limit/here/yeah';
    const result = truncatePath(long);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.startsWith('…/')).toBe(true);
  });
  it('respects custom maxLen', () => {
    const path = '/a/b/c/d/e/f';
    const result = truncatePath(path, 8);
    expect(result.length).toBeLessThanOrEqual(8);
  });
});

// ─── formatHumanReadable ─────────────────────────────────────────────────────

describe('formatHumanReadable', () => {
  it('fully-populated daemon snapshot', () => {
    const now = Date.now();
    const s = makeStatus({
      watchdog: { pid: 9999, alive: true },
      fetchResult: {
        ok: true,
        data: {
          daemon: {
            pid: 12345,
            uptimeSec: 2850,
            startedAt: new Date(now - 2_850_000).toISOString(),
            hostname: 'test-host',
            port: 47891,
          },
          pending: { permissions: 1, notifications: 2, replies: 0 },
          mode: 'away',
          gaming: { active: true, until: null },
          sleeping: {
            active: [
              {
                slug: 'fix-bot-ux',
                branch: 'sleep/fix-bot-ux',
                worktreePath: '/tmp/fix-bot-ux',
                startedAt: now - 720_000,
                expectedEndAt: now + 6_480_000,
              },
            ],
            capacity: 6,
          },
          injectClients: [
            {
              slug: 'poe-alt-crafter',
              pid: 9876,
              cwd: 'C:/Users/juanj/work/PoeAltCrafter',
              localPort: 33333,
              registeredAt: now,
              sessions: [],
            },
          ],
          topics: { forumMode: true, count: 5 },
        },
      },
    });
    const out = formatHumanReadable(s);
    expect(out).toContain('watchdog: alive (PID=9999)');
    expect(out).toContain('daemon: alive (PID=12345)');
    expect(out).toContain('uptime=47m');
    expect(out).toContain('mode: away');
    expect(out).toContain('gaming: armed (sem timer)');
    expect(out).toContain('fix-bot-ux');
    expect(out).toContain('poe-alt-crafter');
    expect(out).toContain('forumMode on, 5 mapeados');
    expect(out).toContain('hooks: Notification, PreToolUse, Stop');
  });

  it('empty states rendered explicitly', () => {
    const out = formatHumanReadable(makeStatus());
    expect(out).toContain('gaming: off');
    expect(out).toContain('sleeps: none active');
    expect(out).toContain('inject clients: none');
    expect(out).toContain('DM mode (forumMode off)');
  });

  it('daemon offline path', () => {
    const out = formatHumanReadable(
      makeStatus({
        daemonPid: 20652,
        daemonAlive: false,
        fetchResult: { ok: false, error: 'ECONNREFUSED' },
        mode: 'here',
        installedHooks: ['Notification'],
      }),
    );
    expect(out).toContain('daemon: dead (stale PID=20652)');
    expect(out).toContain('ECONNREFUSED');
    expect(out).toContain('from disk — daemon offline');
    expect(out).toContain('daemon offline — gaming/sleeps');
    expect(out).toContain('hooks: Notification');
    expect(out).not.toContain('gaming:');
    expect(out).not.toContain('sleeps:');
  });

  it('watchdog stale shows warning', () => {
    const out = formatHumanReadable(
      makeStatus({ watchdog: { pid: 5555, alive: false } }),
    );
    expect(out).toContain('stale PID file (PID=5555');
  });

  it('no watchdog row when watchdog is null', () => {
    const out = formatHumanReadable(makeStatus({ watchdog: null }));
    expect(out).not.toContain('watchdog:');
  });

  it('gaming armed with timer', () => {
    const until = Date.now() + 1_800_000; // 30 min
    const s = makeStatus({
      fetchResult: {
        ok: true,
        data: {
          ...(makeStatus().fetchResult as { ok: true; data: StatusData }).data,
          gaming: { active: true, until },
        },
      },
    });
    const out = formatHumanReadable(s);
    expect(out).toContain('armed');
    expect(out).not.toContain('sem timer');
  });
});

// ─── formatJson ──────────────────────────────────────────────────────────────

describe('formatJson', () => {
  it('emits valid JSON', () => {
    const s = makeStatus();
    const json = formatJson(s);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('schema snapshot — key fields present', () => {
    const s = makeStatus();
    const parsed = JSON.parse(formatJson(s)) as Record<string, unknown>;
    expect(parsed.configPath).toBeDefined();
    expect(parsed.daemonPid).toBeDefined();
    expect(parsed.fetchResult).toBeDefined();
    expect(parsed.installedHooks).toBeDefined();
  });
});

// ─── formatQuiet ─────────────────────────────────────────────────────────────

describe('formatQuiet', () => {
  it('alive daemon → exitCode 0', () => {
    const result = formatQuiet(makeStatus());
    expect(result.text).toBe('daemon: alive');
    expect(result.exitCode).toBe(0);
  });

  it('dead daemon → exitCode 1', () => {
    const result = formatQuiet(
      makeStatus({
        daemonAlive: false,
        fetchResult: { ok: false, error: 'ECONNREFUSED' },
      }),
    );
    expect(result.text).toBe('daemon: dead');
    expect(result.exitCode).toBe(1);
  });

  it('daemon alive but fetch failed → dead (conservative)', () => {
    const result = formatQuiet(
      makeStatus({
        daemonAlive: true,
        fetchResult: { ok: false, error: 'timeout' },
      }),
    );
    expect(result.exitCode).toBe(1);
  });
});
