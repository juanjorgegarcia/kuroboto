import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureIO,
  jsonResponse,
  stubFetch,
  TEST_CONFIG,
  type FetchStub,
} from '../../helpers/cliHarness.js';
import * as stateModule from '../../../src/daemon/state.js';

vi.mock('../../../src/config/load.js', () => ({
  loadConfig: vi.fn(async () => TEST_CONFIG),
}));

import { hereCommand, awayCommand } from '../../../src/cli/mode.js';

describe('cli/mode', () => {
  let io: ReturnType<typeof captureIO>;
  let saveModeSpy: ReturnType<typeof vi.spyOn>;
  let fetchStub: FetchStub;

  beforeEach(() => {
    io = captureIO();
    saveModeSpy = vi.spyOn(stateModule, 'saveMode').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('here: persists mode locally, PUTs /v1/mode, prints "mode set to here"', async () => {
    fetchStub = stubFetch(() => jsonResponse({ ok: true }));
    await hereCommand();
    expect(saveModeSpy).toHaveBeenCalledWith('here');
    const call = fetchStub.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toContain('/v1/mode');
    expect(call.body).toEqual({ mode: 'here' });
    expect(io.out()).toContain('mode set to here');
  });

  it('away: persists mode locally, PUTs /v1/mode, prints "mode set to away"', async () => {
    fetchStub = stubFetch(() => jsonResponse({ ok: true }));
    await awayCommand();
    expect(saveModeSpy).toHaveBeenCalledWith('away');
    expect(fetchStub.calls[0]!.body).toEqual({ mode: 'away' });
    expect(io.out()).toContain('mode set to away');
  });

  it('daemon offline: still saves locally and reports fallback', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await hereCommand();
    expect(saveModeSpy).toHaveBeenCalledWith('here');
    const out = io.out();
    expect(out).toContain('mode set to here');
    expect(out).toContain('daemon offline');
  });

  it('daemon returns non-2xx: reports HTTP code in fallback message', async () => {
    fetchStub = stubFetch(() => jsonResponse({ error: 'bad' }, 500));
    await awayCommand();
    expect(saveModeSpy).toHaveBeenCalledWith('away');
    const out = io.out();
    expect(out).toContain('mode set to away');
    expect(out).toContain('500');
  });
});
