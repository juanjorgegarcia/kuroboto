import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureIO,
  expectAuthHeader,
  jsonResponse,
  runWithExitCapture,
  stubFetch,
  TEST_CONFIG,
  type FetchStub,
} from '../../helpers/cliHarness.js';

vi.mock('../../../src/config/load.js', () => ({
  loadConfig: vi.fn(async () => TEST_CONFIG),
}));

import {
  gamingOnCommand,
  gamingOffCommand,
  gamingStatusCommand,
} from '../../../src/cli/gaming.js';

describe('cli/gaming', () => {
  let io: ReturnType<typeof captureIO>;
  let fetchStub: FetchStub;

  beforeEach(() => {
    io = captureIO();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('on (no duration): PUT {on:true}, prints "gaming on (no timer ...)" and sends auth header', async () => {
    fetchStub = stubFetch(() =>
      jsonResponse({ ok: true, active: true, until: null }),
    );
    await gamingOnCommand();
    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toContain('/v1/gaming');
    expect(call.body).toEqual({ on: true, durationMs: undefined });
    expect(io.out()).toContain('gaming on');
    expect(io.out()).toContain('no timer');
    expectAuthHeader(fetchStub);
  });

  it('on 15m: durationMs=900_000, prints remaining', async () => {
    const future = Date.now() + 15 * 60_000;
    fetchStub = stubFetch(() =>
      jsonResponse({ ok: true, active: true, until: future }),
    );
    await gamingOnCommand('15m');
    expect(fetchStub.calls[0]!.body).toMatchObject({
      on: true,
      durationMs: 15 * 60_000,
    });
    expect(io.out()).toMatch(/15m remaining/);
  });

  it('on 2h: durationMs=7_200_000', async () => {
    const future = Date.now() + 2 * 3_600_000;
    fetchStub = stubFetch(() =>
      jsonResponse({ ok: true, active: true, until: future }),
    );
    await gamingOnCommand('2h');
    expect(fetchStub.calls[0]!.body).toMatchObject({
      on: true,
      durationMs: 2 * 3_600_000,
    });
    expect(io.out()).toMatch(/2h remaining/);
  });

  it('on bad: parseDuration error → exits 1', async () => {
    fetchStub = stubFetch(() =>
      jsonResponse({ ok: true, active: true, until: null }),
    );
    const r = await runWithExitCapture(() => gamingOnCommand('not-a-duration'));
    expect(r.exitCode).toBe(1);
    expect(fetchStub.calls).toHaveLength(0);
    expect(io.err().toLowerCase()).toMatch(/duration|invalid/);
  });

  it('off: PUT {on:false}, prints "gaming off"', async () => {
    fetchStub = stubFetch(() =>
      jsonResponse({ ok: true, active: false, until: null }),
    );
    await gamingOffCommand();
    expect(fetchStub.calls[0]!.body).toEqual({ on: false, durationMs: undefined });
    expect(io.out()).toContain('gaming off');
  });

  it('status (off): GET, prints "gaming: off"', async () => {
    fetchStub = stubFetch(() => jsonResponse({ active: false, until: null }));
    await gamingStatusCommand();
    expect(fetchStub.calls[0]!.method).toBe('GET');
    expect(io.out()).toContain('gaming: off');
  });

  it('status (on, no timer): prints "gaming: on (no timer)"', async () => {
    fetchStub = stubFetch(() => jsonResponse({ active: true, until: null }));
    await gamingStatusCommand();
    expect(io.out()).toContain('gaming: on');
    expect(io.out()).toContain('no timer');
  });

  it('status (on, with timer): prints remaining', async () => {
    const future = Date.now() + 10 * 60_000;
    fetchStub = stubFetch(() => jsonResponse({ active: true, until: future }));
    await gamingStatusCommand();
    const out = io.out();
    expect(out).toContain('gaming: on');
    expect(out).toMatch(/\d+m/);
  });

  it('daemon offline (on): kuroFetch prints daemon-down message and exits 1', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    stubFetch(() => {
      throw err;
    });
    const r = await runWithExitCapture(() => gamingOnCommand());
    expect(r.exitCode).toBe(1);
    expect(io.err()).toMatch(/daemon offline/i);
  });
});
