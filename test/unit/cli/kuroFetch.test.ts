import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/config/load.js', () => ({
  loadConfig: async () => ({
    daemon: { port: 47891, authToken: 'a'.repeat(64) },
  }),
}));

import { kuroFetch, setDebug } from '../../../src/cli/http.js';

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

describe('kuroFetch', () => {
  let restoreFetch: (() => void) | null = null;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setDebug(false);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('builds full URL from path, attaches auth header, returns parsed body', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true, value: 42 }));
    restoreFetch = cap.restore;
    const result = await kuroFetch<{ ok: boolean; value: number }>('/v1/health');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, value: 42 });
    expect(cap.calls[0].url).toBe('http://127.0.0.1:47891/v1/health');
    const headers = cap.calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Kuroboto-Token']).toBe('a'.repeat(64));
  });

  it('serialises body as JSON and adds Content-Type header on POST', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true }));
    restoreFetch = cap.restore;
    await kuroFetch('/v1/topics/clear', { method: 'POST', body: { slug: 'foo' } });
    expect(cap.calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(cap.calls[0].init?.body))).toEqual({ slug: 'foo' });
    const headers = cap.calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns non-2xx responses as ok=false without throwing', async () => {
    const cap = captureFetch(() => jsonResponse({ error: 'bad' }, 400));
    restoreFetch = cap.restore;
    const result = await kuroFetch<{ error: string }>('/v1/whatever');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'bad' });
  });

  it('ECONNREFUSED → prints "daemon offline" and exits 1', async () => {
    restoreFetch = (() => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => {
        const err = new Error('fetch failed') as Error & { cause?: { code?: string } };
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      }) as typeof fetch;
      return () => { globalThis.fetch = original; };
    })();
    await expect(kuroFetch('/v1/health')).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/daemon offline/i);
    expect(written).toMatch(/kuroboto start -d/);
  });

  it('ETIMEDOUT → prints "daemon offline" and exits 1', async () => {
    restoreFetch = (() => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => {
        const err = new Error('fetch failed') as Error & { code?: string };
        err.code = 'ETIMEDOUT';
        throw err;
      }) as typeof fetch;
      return () => { globalThis.fetch = original; };
    })();
    await expect(kuroFetch('/v1/health')).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/daemon offline/i);
  });

  it('unrelated fetch error → exits 1 with the original message (not "daemon offline")', async () => {
    restoreFetch = (() => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error('TLS cert expired');
      }) as typeof fetch;
      return () => { globalThis.fetch = original; };
    })();
    await expect(kuroFetch('/v1/health')).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/TLS cert expired/);
    expect(written).not.toMatch(/daemon offline/);
  });

  it('debug mode → traces request and response on stderr', async () => {
    const cap = captureFetch(() => jsonResponse({ value: 7 }));
    restoreFetch = cap.restore;
    setDebug(true);
    try {
      await kuroFetch('/v1/health', { method: 'POST', body: { x: 1 } });
    } finally {
      setDebug(false);
    }
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/\[debug\] POST http:\/\/127\.0\.0\.1:47891\/v1\/health/);
    expect(written).toMatch(/\{"x":1\}/);
    expect(written).toMatch(/← 200/);
    expect(written).toMatch(/"value":7/);
  });

  it('debug off → no stderr trace lines', async () => {
    const cap = captureFetch(() => jsonResponse({ ok: true }));
    restoreFetch = cap.restore;
    setDebug(false);
    await kuroFetch('/v1/health');
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toBe('');
  });
});
