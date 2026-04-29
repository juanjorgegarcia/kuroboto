import { vi, type MockInstance } from 'vitest';
import type { ConfigT } from '../../src/config/schema.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

export interface FetchStub {
  calls: FetchCall[];
  mock: ReturnType<typeof vi.fn>;
}

/**
 * Replace global.fetch with a vi.fn that delegates to the supplied handler.
 * Each call is recorded for assertions in `calls`.
 */
export function stubFetch(handler: FetchHandler): FetchStub {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k]!;
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, headers, body });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface CapturedIO {
  stdout: string[];
  stderr: string[];
  out(): string;
  err(): string;
}

/**
 * Capture every write to process.stdout / process.stderr AND every console.log /
 * console.error call. Vitest intercepts console.* directly (not via stdout.write),
 * so we must spy on both layers to cover commands that mix the two (`auditExport`
 * uses `process.stdout.write`, while everyone else uses `console.log`).
 *
 * Strip ANSI in the convenience `out()` / `err()` accessors.
 */
export function captureIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  });
  return {
    stdout,
    stderr,
    out: () => stripAnsi(stdout.join('')),
    err: () => stripAnsi(stderr.join('')),
  };
}

export interface ExitCapture {
  exitSpy: MockInstance;
  /** Last code passed to process.exit, or null if never called. */
  code(): number | null;
}

/** Replace process.exit with a stub that throws `__exit__:N` to short-circuit. */
export function stubExit(): ExitCapture {
  let lastCode: number | null = null;
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      lastCode = code ?? 0;
      throw new Error(`__exit__:${lastCode}`);
    }) as never);
  return { exitSpy, code: () => lastCode };
}

/**
 * Run a CLI command, swallowing the `__exit__:N` sentinel so tests can
 * inspect exit code and captured output without try/catch boilerplate.
 *
 * Re-throws unexpected errors so genuine failures still surface.
 */
export async function runWithExitCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result?: T; exitCode: number | null; error?: unknown }> {
  let lastCode: number | null = null;
  const spy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    lastCode = code ?? 0;
    throw new Error(`__exit__:${lastCode}`);
  }) as never);
  try {
    const result = await fn();
    return { result, exitCode: lastCode };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('__exit__:')) {
      return { exitCode: lastCode };
    }
    return { exitCode: lastCode, error: e };
  } finally {
    spy.mockRestore();
  }
}

/** Default config used by the loadConfig mock. Override per-test if needed. */
export const TEST_CONFIG: ConfigT = {
  channel: { type: 'telegram', token: 'x', chatId: 1 },
  daemon: { port: 47891, authToken: 't'.repeat(64) },
  inject: { enabled: false, replyTimeoutMs: 7_200_000 },
  policy: {
    permissionTimeoutMs: 1_000,
    notifyDelayMs: 60_000,
    permissionMatchers: ['Bash', 'Edit', 'Write'],
    rememberGranularity: 'tight',
    gamingAlwaysAsk: [],
    sleepMaxDurationMs: 7_200_000,
    sleepWorktreeDir: '/tmp/kuroboto-test-worktrees',
    maxConcurrentSleeps: 6,
    failOpen: true,
  },
};
