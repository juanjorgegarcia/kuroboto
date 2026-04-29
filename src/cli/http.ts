import chalk from 'chalk';
import { loadConfig } from '../config/load.js';

export interface KuroFetchOptions {
  /** HTTP method (GET when omitted). */
  method?: string;
  /** JSON-serialisable body — `Content-Type: application/json` is added automatically. */
  body?: unknown;
  /** Per-request timeout. Defaults to 5_000 ms; raise for long-running endpoints. */
  timeoutMs?: number;
}

export interface KuroFetchResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

let debugFlag = false;

/** Toggle debug tracing for every subsequent kuroFetch call. */
export function setDebug(on: boolean): void {
  debugFlag = on;
}

export function isDebug(): boolean {
  return debugFlag;
}

/**
 * Wrapper over `fetch` for daemon HTTP calls. Adds the auth header, prints a
 * friendly "daemon offline" message on connection-refused (instead of letting
 * `fetch failed` bubble up unannotated), and emits stderr trace lines when
 * --debug is active.
 *
 * Returns the parsed JSON body alongside the status code; non-2xx responses
 * are returned as-is — callers decide how to handle them.
 */
export async function kuroFetch<T = unknown>(
  pathOrUrl: string,
  opts: KuroFetchOptions = {},
): Promise<KuroFetchResult<T>> {
  const config = await loadConfig();
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `http://127.0.0.1:${config.daemon.port}${pathOrUrl}`;
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    'X-Kuroboto-Token': config.daemon.authToken,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  if (debugFlag) {
    process.stderr.write(`[debug] ${method} ${url}${body ? ` ${body}` : ''}\n`);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    handleFetchError(e);
    // handleFetchError exits the process; this throw keeps TS happy.
    throw e;
  }
  clearTimeout(timer);

  let parsed: T;
  const text = await res.text();
  try {
    parsed = (text ? JSON.parse(text) : {}) as T;
  } catch {
    parsed = text as unknown as T;
  }

  if (debugFlag) {
    process.stderr.write(`[debug] ← ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}\n`);
  }

  return { status: res.status, ok: res.ok, body: parsed };
}

/**
 * Detect the connection-refused / timed-out / aborted family of errors that
 * mean "daemon is not running" and exit with a clear message. Other errors
 * propagate.
 */
function handleFetchError(e: unknown): never {
  const err = e as Error & { code?: string; cause?: { code?: string } };
  const codes = [err.code, err.cause?.code];
  const offline =
    codes.includes('ECONNREFUSED') ||
    codes.includes('ETIMEDOUT') ||
    err.name === 'AbortError';
  if (offline) {
    process.stderr.write(
      chalk.red('✗ daemon offline. start it with `kuroboto start -d`.\n'),
    );
    process.exit(1);
  }
  process.stderr.write(chalk.red(`✗ daemon request failed: ${err.message}\n`));
  process.exit(1);
}
