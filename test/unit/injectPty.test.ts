import { describe, it, expect, vi } from 'vitest';
import { injectViaPty } from '../../src/inject/pty.js';
import type { ClientInfo } from '../../src/daemon/injectClients.js';

function makeClient(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    slug: 'foo',
    pid: 100,
    cwd: '/x/foo',
    localPort: 50000,
    registeredAt: Date.now(),
    ...overrides,
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('injectViaPty', () => {
  it('POSTs JSON body { text } to 127.0.0.1:<port>/inject with auth header', async () => {
    const fetchSpy = vi.fn(async () => okResponse());
    await injectViaPty(makeClient({ localPort: 51234 }), 'hello world', {
      authToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:51234/inject');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Kuroboto-Token']).toBe('tok');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello world' });
  });

  it('resolves on 200', async () => {
    const fetchSpy = vi.fn(async () => okResponse());
    await expect(
      injectViaPty(makeClient(), 'x', { authToken: 't', fetchImpl: fetchSpy as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('rejects on 4xx with status + body', async () => {
    const fetchSpy = vi.fn(async () => new Response('bad token', { status: 401 }));
    await expect(
      injectViaPty(makeClient(), 'x', { authToken: 't', fetchImpl: fetchSpy as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 401.*bad token/);
  });

  it('rejects on 5xx', async () => {
    const fetchSpy = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(
      injectViaPty(makeClient(), 'x', { authToken: 't', fetchImpl: fetchSpy as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('rejects on connection refused (fetch throws)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' });
    });
    await expect(
      injectViaPty(makeClient(), 'x', { authToken: 't', fetchImpl: fetchSpy as unknown as typeof fetch }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('rejects with timeout when AbortController fires', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      // Simulate a fetch that respects AbortSignal but never resolves until aborted
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
          reject(e);
        });
      });
    });
    await expect(
      injectViaPty(makeClient(), 'x', {
        authToken: 't',
        timeoutMs: 20,
        fetchImpl: fetchSpy as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});
