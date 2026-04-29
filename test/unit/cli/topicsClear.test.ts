import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/config/load.js', () => ({
  loadConfig: async () => ({
    daemon: { port: 47891, authToken: 'a'.repeat(64) },
  }),
}));

vi.mock('prompts', () => ({
  default: vi.fn(async () => ({ val: true })),
}));

import { topicsClearCommand } from '../../../src/cli/topicsClear.js';

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function captureFetch(responder: (req: CapturedRequest) => Response | Promise<Response>): {
  calls: CapturedRequest[];
  restore: () => void;
} {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { url: typeof input === 'string' ? input : input.toString(), init };
    calls.push(req);
    return responder(req);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('topicsClearCommand', () => {
  let restoreFetch: (() => void) | null = null;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('POSTs { slug } when given a slug', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true, cleared: ['feat-x'], failed: [], dryRun: false }));
    restoreFetch = cap.restore;
    await topicsClearCommand('feat-x', { yes: true });
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toContain('/v1/topics/clear');
    expect(JSON.parse(String(cap.calls[0].init?.body))).toEqual({ slug: 'feat-x', dryRun: undefined });
  });

  it('POSTs { all: true } with --all', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true, cleared: ['a', 'b'], failed: [], dryRun: false }));
    restoreFetch = cap.restore;
    await topicsClearCommand(undefined, { all: true, yes: true });
    expect(JSON.parse(String(cap.calls[0].init?.body))).toEqual({ all: true, dryRun: undefined });
  });

  it('refuses when neither slug nor --all is given', async () => {
    await expect(topicsClearCommand(undefined, {})).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses when both slug and --all are given', async () => {
    await expect(topicsClearCommand('foo', { all: true })).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('--dry-run sends dryRun:true and prints would-clear list', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true, cleared: ['a', 'b'], failed: [], dryRun: true }));
    restoreFetch = cap.restore;
    await topicsClearCommand(undefined, { all: true, dryRun: true });
    const body = JSON.parse(String(cap.calls[0].init?.body));
    expect(body.dryRun).toBe(true);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/would clear 2 topics/);
  });

  it('prints actionable message when daemon reports forumMode off', async () => {
    const cap = captureFetch(() => jsonResponse({ error: 'channel does not support forum topics' }, 400));
    restoreFetch = cap.restore;
    await expect(topicsClearCommand('foo', { yes: true })).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/forum topics/);
    expect(printed).toMatch(/chat clear/);
  });

  it('exits non-zero when some topics failed', async () => {
    const cap = captureFetch(() => jsonResponse({
      ok: true,
      cleared: ['a'],
      failed: [{ key: 'b', error: 'topic not found' }],
      dryRun: false,
    }));
    restoreFetch = cap.restore;
    await expect(topicsClearCommand(undefined, { all: true, yes: true })).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
