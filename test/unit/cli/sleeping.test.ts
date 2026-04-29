import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import prompts from 'prompts';
import {
  captureIO,
  jsonResponse,
  runWithExitCapture,
  stubFetch,
  TEST_CONFIG,
  type FetchStub,
} from '../../helpers/cliHarness.js';

vi.mock('prompts', () => ({ default: vi.fn() }));
vi.mock('../../../src/config/load.js', () => ({
  loadConfig: vi.fn(async () => TEST_CONFIG),
}));

const mockedPrompts = vi.mocked(prompts);

import {
  sleepingStartCommand,
  sleepingStatusCommand,
  sleepingCancelCommand,
} from '../../../src/cli/sleeping.js';

interface SnapSession {
  slug: string;
  branch: string;
  worktreePath: string;
  startedAt: number;
  expectedEndAt: number;
}

function snap(session: Partial<SnapSession> = {}): SnapSession {
  const now = Date.now();
  return {
    slug: 'demo-aaa111',
    branch: 'sleep/demo-aaa111',
    worktreePath: '/tmp/wt/demo-aaa111',
    startedAt: now,
    expectedEndAt: now + 60 * 60 * 1000,
    ...session,
  };
}

describe('cli/sleeping', () => {
  let io: ReturnType<typeof captureIO>;
  let fetchStub: FetchStub;

  beforeEach(() => {
    io = captureIO();
    mockedPrompts.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('status', () => {
    it('idle: prints "sleep: idle (cap 6)"', async () => {
      fetchStub = stubFetch(() => jsonResponse({ active: [], capacity: 6 }));
      await sleepingStatusCommand();
      expect(io.out()).toContain('sleep: idle (cap 6)');
      expect(fetchStub.calls).toHaveLength(1);
      expect(fetchStub.calls[0]!.url).toContain('/v1/sleeping');
      expect(fetchStub.calls[0]!.method).toBe('GET');
    });

    it('one active: prints count line + slug bullet', async () => {
      fetchStub = stubFetch(() =>
        jsonResponse({ active: [snap({ slug: 'one-x' })], capacity: 6 }),
      );
      await sleepingStatusCommand();
      const out = io.out();
      expect(out).toContain('sleep: 1 active (cap 6)');
      expect(out).toContain('• one-x');
      expect(out).toMatch(/remaining/);
    });

    it('multiple active: count line + bullet per session', async () => {
      fetchStub = stubFetch(() =>
        jsonResponse({
          active: [snap({ slug: 'first-1' }), snap({ slug: 'second-2' })],
          capacity: 6,
        }),
      );
      await sleepingStatusCommand();
      const out = io.out();
      expect(out).toContain('sleep: 2 active (cap 6)');
      expect(out).toContain('• first-1');
      expect(out).toContain('• second-2');
    });
  });

  describe('start', () => {
    it('rejects when both --prompt and --plan are given', async () => {
      const r = await runWithExitCapture(() =>
        sleepingStartCommand({ prompt: 'x', plan: 'y' }),
      );
      expect(r.exitCode).toBe(1);
      expect(io.err()).toContain('mutually exclusive');
    });

    it('rejects when neither --prompt nor --plan is given', async () => {
      const r = await runWithExitCapture(() => sleepingStartCommand({}));
      expect(r.exitCode).toBe(1);
      expect(io.err()).toContain('--prompt or --plan required');
    });

    it('--prompt: POSTs to /v1/sleeping and prints session details', async () => {
      const session = snap({ slug: 'echo-hi-zz9999' });
      fetchStub = stubFetch(() => jsonResponse(session));
      await sleepingStartCommand({ prompt: 'echo hi', repo: '/repo/x' });
      expect(fetchStub.calls).toHaveLength(1);
      const call = fetchStub.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toContain('/v1/sleeping');
      expect(call.body).toMatchObject({ repo: path.resolve('/repo/x'), prompt: 'echo hi' });
      const out = io.out();
      expect(out).toContain('💤 sleep started');
      expect(out).toContain(`slug:     ${session.slug}`);
      expect(out).toContain(`branch:   ${session.branch}`);
      expect(out).toContain(`worktree: ${session.worktreePath}`);
    });

    it('--plan: reads file and posts plan content', async () => {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-cli-'));
      const planFile = path.join(tmp, 'plan.md');
      await fsp.writeFile(planFile, '# Plan\n\nDo X');
      try {
        const session = snap();
        fetchStub = stubFetch(() => jsonResponse(session));
        await sleepingStartCommand({ plan: planFile, repo: '/repo/x' });
        const body = fetchStub.calls[0]!.body as { plan?: string; prompt?: string };
        expect(body.plan).toContain('# Plan');
        expect(body.prompt).toBeUndefined();
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    });

    it('capacity reached (429): renders error block and rejects', async () => {
      fetchStub = stubFetch(() =>
        jsonResponse(
          {
            error: 'capacity',
            capacity: 2,
            active: [snap({ slug: 'busy-1' }), snap({ slug: 'busy-2' })],
          },
          429,
        ),
      );
      await expect(sleepingStartCommand({ prompt: 'p' })).rejects.toThrow(
        /capacity/i,
      );
      const err = io.err();
      expect(err).toContain('capacity reached');
      expect(err).toContain('2/2 active');
      expect(err).toContain('busy-1');
      expect(err).toContain('busy-2');
    });
  });

  describe('cancel', () => {
    it('no active sleeps: prints "(no active sleeps)" and returns', async () => {
      fetchStub = stubFetch(() => jsonResponse({ active: [], capacity: 6 }));
      await sleepingCancelCommand(undefined, {});
      expect(io.out()).toContain('(no active sleeps)');
      // status GET only — no cancel POST
      expect(fetchStub.calls).toHaveLength(1);
    });

    it('explicit slug: POSTs cancel without prompting', async () => {
      const s = snap({ slug: 'target-1' });
      fetchStub = stubFetch((url) => {
        if (url.includes('/cancel')) return jsonResponse({ cancelled: ['target-1'] });
        return jsonResponse({ active: [s], capacity: 6 });
      });
      await sleepingCancelCommand('target-1', {});
      expect(mockedPrompts).not.toHaveBeenCalled();
      expect(io.out()).toContain('sleep cancelled: target-1');
      const cancelCall = fetchStub.calls.find((c) => c.url.includes('/cancel'))!;
      expect(cancelCall.body).toEqual({ slug: 'target-1' });
    });

    it('explicit slug not found: prints error and exits 1', async () => {
      fetchStub = stubFetch(() =>
        jsonResponse({ active: [snap({ slug: 'other' })], capacity: 6 }),
      );
      const r = await runWithExitCapture(() =>
        sleepingCancelCommand('missing', {}),
      );
      expect(r.exitCode).toBe(1);
      expect(io.err()).toContain("no active sleep with slug 'missing'");
    });

    it('one active, no slug: confirmation y → cancels', async () => {
      const s = snap({ slug: 'lonely-1' });
      mockedPrompts.mockResolvedValueOnce({ val: true });
      fetchStub = stubFetch((url) => {
        if (url.includes('/cancel')) return jsonResponse({ cancelled: ['lonely-1'] });
        return jsonResponse({ active: [s], capacity: 6 });
      });
      await sleepingCancelCommand(undefined, {});
      expect(mockedPrompts).toHaveBeenCalledTimes(1);
      const arg = mockedPrompts.mock.calls[0]![0] as { message: string };
      expect(arg.message).toContain('lonely-1');
      expect(io.out()).toContain('sleep cancelled: lonely-1');
    });

    it('one active, no slug: confirmation n → aborts', async () => {
      mockedPrompts.mockResolvedValueOnce({ val: false });
      fetchStub = stubFetch(() =>
        jsonResponse({ active: [snap({ slug: 'spared' })], capacity: 6 }),
      );
      await sleepingCancelCommand(undefined, {});
      expect(io.out()).toContain('aborted');
      // No /cancel POST should have happened
      expect(fetchStub.calls.some((c) => c.url.includes('/cancel'))).toBe(false);
    });

    it('--all confirmed: cancels every active session', async () => {
      mockedPrompts.mockResolvedValueOnce({ val: true });
      const a = snap({ slug: 'a-aaaaaa' });
      const b = snap({ slug: 'b-bbbbbb' });
      fetchStub = stubFetch((url) => {
        if (url.includes('/cancel')) {
          return jsonResponse({ cancelled: ['a-aaaaaa', 'b-bbbbbb'] });
        }
        return jsonResponse({ active: [a, b], capacity: 6 });
      });
      await sleepingCancelCommand(undefined, { all: true });
      expect(mockedPrompts).toHaveBeenCalledTimes(1);
      const cancelCall = fetchStub.calls.find((c) => c.url.includes('/cancel'))!;
      expect(cancelCall.body).toEqual({ all: true });
      expect(io.out()).toContain('cancelled 2 sleeps');
      expect(io.out()).toContain('a-aaaaaa, b-bbbbbb');
    });

    it('--all --yes: skips prompt', async () => {
      const a = snap({ slug: 'a-1' });
      const b = snap({ slug: 'b-2' });
      fetchStub = stubFetch((url) => {
        if (url.includes('/cancel')) return jsonResponse({ cancelled: ['a-1', 'b-2'] });
        return jsonResponse({ active: [a, b], capacity: 6 });
      });
      await sleepingCancelCommand(undefined, { all: true, yes: true });
      expect(mockedPrompts).not.toHaveBeenCalled();
      expect(io.out()).toContain('cancelled 2 sleeps');
    });

    it('--yes single active: skips prompt', async () => {
      const s = snap({ slug: 'solo-1' });
      fetchStub = stubFetch((url) => {
        if (url.includes('/cancel')) return jsonResponse({ cancelled: ['solo-1'] });
        return jsonResponse({ active: [s], capacity: 6 });
      });
      await sleepingCancelCommand(undefined, { yes: true });
      expect(mockedPrompts).not.toHaveBeenCalled();
      expect(io.out()).toContain('sleep cancelled: solo-1');
    });

    it('--yes multi active, no slug: cancels most-recent silently', async () => {
      const older = snap({ slug: 'older-x', startedAt: 1_000 });
      const newer = snap({ slug: 'newer-y', startedAt: 9_000 });
      fetchStub = stubFetch((url) => {
        if (url.includes('/cancel')) return jsonResponse({ cancelled: ['newer-y'] });
        return jsonResponse({ active: [older, newer], capacity: 6 });
      });
      await sleepingCancelCommand(undefined, { yes: true });
      expect(mockedPrompts).not.toHaveBeenCalled();
      const cancelCall = fetchStub.calls.find((c) => c.url.includes('/cancel'))!;
      expect(cancelCall.body).toEqual({ slug: 'newer-y' });
      expect(io.out()).toContain('sleep cancelled: newer-y');
    });
  });
});
