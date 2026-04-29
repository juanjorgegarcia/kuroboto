import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/config/load.js', () => ({
  loadConfig: async () => ({
    daemon: { port: 47891, authToken: 'a'.repeat(64) },
  }),
}));

vi.mock('prompts', () => ({
  default: vi.fn(async () => ({ val: true })),
}));

import { chatClearCommand } from '../../../src/cli/chatClear.js';

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

describe('chatClearCommand', () => {
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

  it('POSTs { last: N } and prints "deleted X of last Y"', async () => {
    const cap = captureFetch(() => jsonResponse({
      ok: true, attempted: 100, deleted: 87, outOfWindow: 13, dryRun: false,
    }));
    restoreFetch = cap.restore;
    await chatClearCommand({ last: '100', yes: true });
    expect(cap.calls).toHaveLength(1);
    expect(JSON.parse(String(cap.calls[0].init?.body))).toEqual({ last: 100, dryRun: false });
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/deleted 87 of last 100/);
    expect(printed).toMatch(/13 outside 48h/);
  });

  it('refuses non-positive --last', async () => {
    await expect(chatClearCommand({ last: '0' })).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses missing --last', async () => {
    await expect(chatClearCommand({})).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses non-numeric --last', async () => {
    await expect(chatClearCommand({ last: 'abc' })).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('--dry-run reports attempted + outside-window without deleting', async () => {
    const cap = captureFetch(() => jsonResponse({
      ok: true, attempted: 50, deleted: 0, outOfWindow: 5, dryRun: true,
    }));
    restoreFetch = cap.restore;
    await chatClearCommand({ last: '50', dryRun: true });
    expect(JSON.parse(String(cap.calls[0].init?.body)).dryRun).toBe(true);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/would attempt 50/);
    expect(printed).toMatch(/5 outside 48h/);
  });

  it('exits 1 on daemon error', async () => {
    const cap = captureFetch(() => jsonResponse({ error: 'channel does not support message deletion' }, 400));
    restoreFetch = cap.restore;
    await expect(chatClearCommand({ last: '5', yes: true })).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
