import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createInjectServer,
  defaultSlug,
  makeDaemonClient,
  readDaemonSentinel,
  runInjectClient,
  type IPty,
  type NodePtyLike,
  type RegisterPayload,
} from '../../src/cli/injectClient.js';

const TEST_TOKEN = 'a'.repeat(64);

interface FakePty extends IPty {
  written: string[];
  resizes: Array<{ cols: number; rows: number }>;
  emitData: (s: string) => void;
  emitExit: (code: number) => void;
}

function makeFakePty(): FakePty {
  let onDataCb: ((s: string) => void) | null = null;
  let onExitCb: ((e: { exitCode: number }) => void) | null = null;
  const written: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  return {
    written,
    resizes,
    onData(cb) { onDataCb = cb; },
    onExit(cb) { onExitCb = cb; },
    write(s) { written.push(s); },
    resize(cols, rows) { resizes.push({ cols, rows }); },
    kill() { /* noop */ },
    emitData(s) { onDataCb?.(s); },
    emitExit(code) { onExitCb?.({ exitCode: code }); },
  };
}

function makeFakePtyMod(out: { last: FakePty | null }): NodePtyLike {
  return {
    spawn() {
      const p = makeFakePty();
      out.last = p;
      return p;
    },
  };
}

describe('defaultSlug', () => {
  it('uses cwd basename + 6-char suffix', () => {
    const s = defaultSlug('/x/Foo Bar/work');
    expect(s).toMatch(/^work-[a-f0-9]{6}$/);
  });
  it('falls back to "claude" for empty basename', () => {
    const s = defaultSlug('/');
    expect(s).toMatch(/^claude-[a-f0-9]{6}$/);
  });
});

describe('createInjectServer', () => {
  let server: http.Server;
  let baseUrl: string;
  let received: string[] = [];

  beforeEach(async () => {
    received = [];
    server = createInjectServer({
      authToken: TEST_TOKEN,
      onInject: (t) => received.push(t),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POST /inject with valid auth + JSON body invokes onInject and returns 200', async () => {
    const res = await fetch(`${baseUrl}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kuroboto-Token': TEST_TOKEN },
      body: JSON.stringify({ text: 'hello world' }),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual(['hello world']);
  });

  it('rejects without auth token (401)', async () => {
    const res = await fetch(`${baseUrl}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('rejects wrong auth token (401)', async () => {
    const res = await fetch(`${baseUrl}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kuroboto-Token': 'wrong' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-JSON body (400)', async () => {
    const res = await fetch(`${baseUrl}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kuroboto-Token': TEST_TOKEN },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects body without text field (400)', async () => {
    const res = await fetch(`${baseUrl}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kuroboto-Token': TEST_TOKEN },
      body: JSON.stringify({ foo: 'bar' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown route (404)', async () => {
    const res = await fetch(`${baseUrl}/`, { method: 'POST', headers: { 'X-Kuroboto-Token': TEST_TOKEN } });
    expect(res.status).toBe(404);
  });
});

describe('makeDaemonClient', () => {
  it('register POSTs payload with auth header and returns ok on 200', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = makeDaemonClient(47891, 'tok', fetchSpy as unknown as typeof fetch);
    const payload: RegisterPayload = { slug: 'foo', pid: 1, cwd: '/x', localPort: 5000 };
    const res = await client.register(payload);
    expect(res.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47891/v1/inject-clients');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Kuroboto-Token']).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('register surfaces 409 with body', async () => {
    const fetchSpy = vi.fn(async () => new Response('slug taken', { status: 409 }));
    const client = makeDaemonClient(47891, 'tok', fetchSpy as unknown as typeof fetch);
    const res = await client.register({ slug: 'foo', pid: 1, cwd: '/x', localPort: 5000 });
    expect(res).toEqual({ ok: false, status: 409, body: 'slug taken' });
  });

  it('register returns ok=false on network error (no throw)', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const client = makeDaemonClient(47891, 'tok', fetchSpy as unknown as typeof fetch);
    const res = await client.register({ slug: 'foo', pid: 1, cwd: '/x', localPort: 5000 });
    expect(res).toEqual({ ok: false, status: 0, body: 'ECONNREFUSED' });
  });

  it('deregister DELETEs and ignores errors', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('boom'); });
    const client = makeDaemonClient(47891, 'tok', fetchSpy as unknown as typeof fetch);
    await expect(client.deregister('foo')).resolves.toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47891/v1/inject-clients/foo');
    expect(init.method).toBe('DELETE');
  });
});

describe('readDaemonSentinel', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-sentinel-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('returns null when file missing', async () => {
    expect(await readDaemonSentinel(path.join(tmp, 'absent.json'))).toBeNull();
  });

  it('returns parsed object on valid JSON with pid+port', async () => {
    const file = path.join(tmp, 'd.json');
    await fsp.writeFile(file, JSON.stringify({ pid: 100, port: 47891, startedAt: '2026-04-28T00:00:00Z' }));
    expect(await readDaemonSentinel(file)).toEqual({
      pid: 100, port: 47891, startedAt: '2026-04-28T00:00:00Z',
    });
  });

  it('returns null on malformed JSON', async () => {
    const file = path.join(tmp, 'bad.json');
    await fsp.writeFile(file, '{not json');
    expect(await readDaemonSentinel(file)).toBeNull();
  });

  it('returns null when required fields missing', async () => {
    const file = path.join(tmp, 'partial.json');
    await fsp.writeFile(file, JSON.stringify({ pid: 100 }));
    expect(await readDaemonSentinel(file)).toBeNull();
  });
});

describe('runInjectClient', () => {
  let tmpConfig: string;
  let origCwd: string;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'kuroboto-runinject-'));
    // Use HOME override so loadConfig resolves CONFIG_FILE under tmp
    origConfigDir = process.env.HOME;
    process.env.HOME = tmpConfig;
    process.env.USERPROFILE = tmpConfig;
    const cfgDir = path.join(tmpConfig, '.config', 'kuroboto');
    await fsp.mkdir(cfgDir, { recursive: true });
    await fsp.writeFile(path.join(cfgDir, 'config.json'), JSON.stringify({
      channel: { type: 'telegram', token: 'x', chatId: 1 },
      daemon: { port: 47891, authToken: TEST_TOKEN },
      inject: { enabled: true, strategy: 'pty', replyTimeoutMs: 60_000 },
      policy: {
        permissionTimeoutMs: 5000, notifyDelayMs: 60_000,
        permissionMatchers: ['Bash'], rememberGranularity: 'tight',
        gamingAlwaysAsk: [], failOpen: true,
        sleepMaxDurationMs: 7_200_000, sleepWorktreeDir: '~/.kuroboto/worktrees',
      },
      notifications: { desktop: false },
    }));
    origCwd = process.cwd();
  });

  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.HOME = origConfigDir;
    else delete process.env.HOME;
    process.chdir(origCwd);
    await fsp.rm(tmpConfig, { recursive: true, force: true });
  });

  it('registers with daemon on startup, deregisters on PTY exit', async () => {
    const ptyState: { last: FakePty | null } = { last: null };
    const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      fetchCalls.push({
        url: u,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const fakeStdin = makeFakeStdin();
    const fakeStdout = makeFakeStdout();
    const watcherCloseSpy = vi.fn();

    const runP = runInjectClient({
      args: [],
      name: 'test-cli',
      pty: makeFakePtyMod(ptyState),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      stdin: fakeStdin as unknown as NodeJS.ReadStream,
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
      watchSentinel: () => ({ close: watcherCloseSpy }),
    });

    // Wait until register has happened
    await waitFor(() => fetchCalls.length >= 1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:47891/v1/inject-clients');
    expect(fetchCalls[0].method).toBe('POST');
    expect((fetchCalls[0].body as RegisterPayload).slug).toBe('test-cli');

    ptyState.last!.emitExit(0);
    const result = await runP;
    expect(result.exitCode).toBe(0);

    const dereg = fetchCalls.find((c) => c.method === 'DELETE');
    expect(dereg?.url).toBe('http://127.0.0.1:47891/v1/inject-clients/test-cli');
    expect(watcherCloseSpy).toHaveBeenCalled();
  });

  it('continues despite daemon offline (network error on register)', async () => {
    const ptyState: { last: FakePty | null } = { last: null };
    const fetchSpy = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const fakeStdin = makeFakeStdin();
    const fakeStdout = makeFakeStdout();

    const runP = runInjectClient({
      args: [],
      name: 'test-cli',
      pty: makeFakePtyMod(ptyState),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      stdin: fakeStdin as unknown as NodeJS.ReadStream,
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
      watchSentinel: () => ({ close: () => {} }),
    });
    // Give registration a tick to error out
    await new Promise((r) => setTimeout(r, 20));
    expect(ptyState.last).not.toBeNull();
    ptyState.last!.emitExit(0);
    await runP;
  });

  it('exits non-zero on slug collision (409) without spawning claude', async () => {
    const ptyState: { last: FakePty | null } = { last: null };
    const fetchSpy = vi.fn(async () => new Response('PID 999', { status: 409 }));
    const fakeStdin = makeFakeStdin();
    const fakeStdout = makeFakeStdout();
    const r = await runInjectClient({
      args: [],
      name: 'test-cli',
      pty: makeFakePtyMod(ptyState),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      stdin: fakeStdin as unknown as NodeJS.ReadStream,
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
      watchSentinel: () => ({ close: () => {} }),
    });
    expect(r.exitCode).toBe(1);
    // pty must not be spawned on collision — server is closed before pty.spawn
    expect(ptyState.last).toBeNull();
  });

  it('sentinel watcher fires re-registration', async () => {
    const ptyState: { last: FakePty | null } = { last: null };
    const fetchCalls: string[] = [];
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      fetchCalls.push(u);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    let triggerWatch: () => void = () => {};
    const fakeStdin = makeFakeStdin();
    const fakeStdout = makeFakeStdout();

    const runP = runInjectClient({
      args: [],
      name: 'test-cli',
      pty: makeFakePtyMod(ptyState),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      stdin: fakeStdin as unknown as NodeJS.ReadStream,
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
      watchSentinel: (cb) => { triggerWatch = cb; return { close: () => {} }; },
    });

    await waitFor(() => fetchCalls.length >= 1);
    triggerWatch();
    triggerWatch();
    await waitFor(() => fetchCalls.filter((u) => u.endsWith('/v1/inject-clients')).length >= 3);
    ptyState.last!.emitExit(0);
    await runP;
  });

  it('forwards stdin data to PTY and PTY data to stdout', async () => {
    const ptyState: { last: FakePty | null } = { last: null };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const fakeStdin = makeFakeStdin();
    const fakeStdout = makeFakeStdout();

    const runP = runInjectClient({
      args: [],
      name: 'test-cli',
      pty: makeFakePtyMod(ptyState),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      stdin: fakeStdin as unknown as NodeJS.ReadStream,
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
      watchSentinel: () => ({ close: () => {} }),
    });
    await waitFor(() => ptyState.last !== null);
    fakeStdin.emit('data', Buffer.from('abc'));
    expect(ptyState.last!.written).toContain('abc');

    ptyState.last!.emitData('hello\n');
    expect(fakeStdout.writes).toContain('hello\n');

    ptyState.last!.emitExit(0);
    await runP;
  });
});

interface FakeStdin {
  isTTY: boolean;
  setRawMode?: (b: boolean) => void;
  resume: () => void;
  pause: () => void;
  on: (e: string, cb: (...args: unknown[]) => void) => void;
  off: (e: string, cb: (...args: unknown[]) => void) => void;
  emit: (e: string, ...args: unknown[]) => void;
}

function makeFakeStdin(): FakeStdin {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    isTTY: false,
    resume() { /* noop */ },
    pause() { /* noop */ },
    on(e, cb) {
      const arr = handlers.get(e) ?? [];
      arr.push(cb);
      handlers.set(e, arr);
    },
    off(e, cb) {
      const arr = handlers.get(e) ?? [];
      handlers.set(e, arr.filter((f) => f !== cb));
    },
    emit(e, ...args) {
      for (const f of handlers.get(e) ?? []) f(...args);
    },
  };
}

interface FakeStdout {
  columns: number;
  rows: number;
  writes: string[];
  write: (s: string) => boolean;
  on: (e: string, cb: () => void) => void;
  off: (e: string, cb: () => void) => void;
  emit: (e: string) => void;
}

function makeFakeStdout(): FakeStdout {
  const handlers = new Map<string, Array<() => void>>();
  return {
    columns: 80,
    rows: 24,
    writes: [],
    write(s) { this.writes.push(s); return true; },
    on(e, cb) {
      const arr = handlers.get(e) ?? [];
      arr.push(cb);
      handlers.set(e, arr);
    },
    off(e, cb) {
      const arr = handlers.get(e) ?? [];
      handlers.set(e, arr.filter((f) => f !== cb));
    },
    emit(e) {
      for (const f of handlers.get(e) ?? []) f();
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}
