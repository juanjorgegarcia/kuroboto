import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import { loadConfig } from '../config/load.js';
import { DAEMON_SENTINEL_FILE } from '../config/paths.js';

export interface DaemonSentinel {
  pid: number;
  port: number;
  startedAt: string;
}

export interface ClaudeRunOpts {
  args: string[];
  name?: string;
  /** node-pty module override for tests. */
  pty?: NodePtyLike;
  /** http.Server factory override for tests (the server hosts /inject locally). */
  serverFactory?: (handler: http.RequestListener) => http.Server;
  /** Custom fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Override stdin for testability. */
  stdin?: NodeJS.ReadStream;
  /** Override stdout for testability. */
  stdout?: NodeJS.WriteStream;
  /** Override the sentinel watcher (tests). */
  watchSentinel?: (cb: () => void) => { close: () => void };
}

export interface NodePtyLike {
  spawn: (
    file: string,
    args: string[],
    options: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv; name?: string },
  ) => IPty;
}

export interface IPty {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
}

export interface RegisterPayload {
  slug: string;
  pid: number;
  cwd: string;
  localPort: number;
}

export interface DaemonClient {
  register(payload: RegisterPayload): Promise<{ ok: true } | { ok: false; status: number; body: string }>;
  deregister(slug: string): Promise<void>;
}

export function makeDaemonClient(
  daemonPort: number,
  authToken: string,
  fetchImpl: typeof fetch = fetch,
): DaemonClient {
  const base = `http://127.0.0.1:${daemonPort}`;
  return {
    async register(payload) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/v1/inject-clients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kuroboto-Token': authToken },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        return { ok: false, status: 0, body: (e as Error).message };
      }
      if (res.ok) return { ok: true };
      let body = '';
      try { body = (await res.text()).trim(); } catch { /* ignore */ }
      return { ok: false, status: res.status, body };
    },
    async deregister(slug) {
      try {
        await fetchImpl(`${base}/v1/inject-clients/${encodeURIComponent(slug)}`, {
          method: 'DELETE',
          headers: { 'X-Kuroboto-Token': authToken },
        });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Slug = basename(cwd) (sanitized) + '-' + 6-char random. Stable shape with
 * sleep mode's slugs; gives a useful default for `kuroboto status` listings.
 */
export function defaultSlug(cwd: string): string {
  const base = path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = randomBytes(3).toString('hex');
  return `${base || 'claude'}-${suffix}`;
}

export interface InjectServerDeps {
  authToken: string;
  /** Called with the inbound text when /inject succeeds. */
  onInject: (text: string) => void;
  /** Server factory (defaults to http.createServer). */
  serverFactory?: (handler: http.RequestListener) => http.Server;
}

/**
 * Local HTTP server hosting POST /inject. Binds 127.0.0.1 only. Validates the
 * shared auth token. Body must be JSON `{ text: string }`. On match, calls
 * `onInject(text)` synchronously and replies `{ ok: true }`.
 */
export function createInjectServer(deps: InjectServerDeps): http.Server {
  const handler: http.RequestListener = (req, res) => {
    if (req.method !== 'POST' || req.url !== '/inject') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const tok = req.headers['x-kuroboto-token'];
    if (typeof tok !== 'string' || tok !== deps.authToken) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let body = '';
    req.on('data', (b: Buffer) => {
      body += b.toString();
      if (body.length > 64 * 1024) {
        res.statusCode = 413;
        res.end();
        req.destroy();
      }
    });
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const text = (parsed as { text?: unknown }).text;
      if (typeof text !== 'string') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'text must be a string' }));
        return;
      }
      try {
        deps.onInject(text);
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (e as Error).message }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  };
  const factory = deps.serverFactory ?? http.createServer;
  return factory(handler);
}

/**
 * Read the daemon-pid sentinel; returns null if missing or malformed (we
 * never throw, since the daemon may legitimately be down at start time).
 */
export async function readDaemonSentinel(file: string = DAEMON_SENTINEL_FILE): Promise<DaemonSentinel | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DaemonSentinel;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * fs.watch the parent dir for changes to the sentinel filename, calling `cb`
 * on every event. Watching the dir (not the file) is necessary because some
 * editors/processes replace the file inode on write.
 */
export function watchDaemonSentinel(cb: () => void, file: string = DAEMON_SENTINEL_FILE): { close: () => void } {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, (_evt, name) => {
      if (name === base || name == null) cb();
    });
  } catch {
    // fs.watch may fail on some filesystems; degrade silently
  }
  return {
    close: () => {
      try { watcher?.close(); } catch { /* ignore */ }
    },
  };
}

export interface RunResult {
  exitCode: number;
}

/**
 * Spawn claude inside a PTY and multiplex with this process's stdio. Local
 * HTTP server accepts /inject. Registers with the daemon (best-effort) and
 * re-registers when the daemon-pid sentinel changes.
 */
export async function runInjectClient(opts: ClaudeRunOpts): Promise<RunResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    process.stderr.write(chalk.red(`[kuroboto] config error: ${(e as Error).message}\n`));
    return { exitCode: 1 };
  }

  const ptyMod = opts.pty ?? (await loadNodePty());
  if (!ptyMod) {
    process.stderr.write(
      chalk.red(
        '[kuroboto] node-pty unavailable; reinstall kuroboto or use --tmux\n',
      ),
    );
    return { exitCode: 1 };
  }

  const cwd = process.cwd();
  const slug = (opts.name && opts.name.trim()) || defaultSlug(cwd);

  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const pty = ptyMod.spawn('claude', opts.args, {
    cols,
    rows,
    cwd,
    env: process.env,
    name: process.env.TERM ?? 'xterm-256color',
  });

  // PTY -> our stdout
  pty.onData((data) => {
    stdout.write(data);
  });

  // our stdin -> PTY (raw mode for arrows, ctrl+C, escape sequences)
  let rawWasOn = false;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(true);
      rawWasOn = true;
    } catch {
      // non-TTY — proceed without raw mode (pipes / tests)
    }
  }
  stdin.resume();
  const onStdinData = (chunk: Buffer | string): void => {
    pty.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  };
  stdin.on('data', onStdinData);

  // Resize: stdout 'resize' fires on Node when the parent terminal is resized.
  const onResize = (): void => {
    try {
      pty.resize(stdout.columns ?? 80, stdout.rows ?? 24);
    } catch {
      // pty may already be dead
    }
  };
  stdout.on('resize', onResize);

  // Local /inject server
  const server = createInjectServer({
    authToken: config.daemon.authToken,
    onInject: (text) => {
      // Send as a single literal write + Enter (matches tmux strategy: -l text, then Enter)
      pty.write(text);
      pty.write('\r');
    },
    serverFactory: opts.serverFactory,
  });
  const localPort: number = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve(addr.port);
      else reject(new Error('server.address() returned no port'));
    });
  });

  const daemon = makeDaemonClient(config.daemon.port, config.daemon.authToken, opts.fetchImpl);
  const payload: RegisterPayload = { slug, pid: process.pid, cwd, localPort };

  const tryRegister = async (announce: boolean): Promise<boolean> => {
    const r = await daemon.register(payload);
    if (r.ok) {
      if (announce) process.stderr.write(chalk.dim(`[kuroboto] registered as "${slug}"\n`));
      return true;
    }
    if (r.status === 409) {
      process.stderr.write(chalk.red(`[kuroboto] slug "${slug}" already in use: ${r.body}\n`));
      return false;
    }
    return false;
  };

  const initialOk = await tryRegister(true);
  if (!initialOk) {
    // 409 is fatal (collision); other failures are tolerated until sentinel changes.
    const sentinel = await readDaemonSentinel();
    if (sentinel) {
      // Daemon up but registration failed for a non-collision reason — keep going.
      process.stderr.write(
        chalk.yellow('[kuroboto] register failed, will retry when daemon sentinel changes\n'),
      );
    } else {
      process.stderr.write(
        chalk.yellow('[kuroboto] daemon offline — Q&A replies will not reach this session until daemon is back\n'),
      );
    }
  }

  // Watch the sentinel: on change, re-register (idempotent on the daemon side).
  const watcher = (opts.watchSentinel ?? watchDaemonSentinel)(() => {
    void tryRegister(true);
  });

  // Wait for claude exit
  const exitCode: number = await new Promise<number>((resolve) => {
    pty.onExit(({ exitCode: code }) => resolve(code));
  });

  // Cleanup
  stdin.off('data', onStdinData);
  stdout.off('resize', onResize);
  if (rawWasOn && typeof stdin.setRawMode === 'function') {
    try { stdin.setRawMode(false); } catch { /* ignore */ }
  }
  stdin.pause();
  watcher.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await daemon.deregister(slug);

  return { exitCode };
}

async function loadNodePty(): Promise<NodePtyLike | null> {
  try {
    const mod = (await import('node-pty')) as unknown as NodePtyLike;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Best-effort safety net: restore the terminal if we crash before the cleanup
 * path runs. Idempotent — safe to call from multiple signal handlers.
 */
export function installCrashSafety(stdin: NodeJS.ReadStream = process.stdin): void {
  const restore = (): void => {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
    }
  };
  process.once('exit', restore);
  process.once('SIGINT', restore);
  process.once('SIGTERM', restore);
  process.once('uncaughtException', (e) => {
    restore();
    process.stderr.write(`[kuroboto] uncaught: ${e.stack ?? e.message}\n`);
    process.exit(1);
  });
}

interface HomedirEnv { HOME?: string; USERPROFILE?: string }
export function expandHome(p: string, env: HomedirEnv = process.env): string {
  if (p.startsWith('~/') || p === '~') {
    const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
    return path.join(home, p.slice(2));
  }
  return p;
}
