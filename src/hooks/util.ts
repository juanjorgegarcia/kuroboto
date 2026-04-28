import { loadConfig } from '../config/load.js';

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export type DaemonResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function postToDaemon<T = unknown>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<DaemonResult<T>> {
  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${config.daemon.port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kuroboto-Token': config.daemon.authToken,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: (e as Error).message };
  }
}

export async function getPermissionTimeoutMs(): Promise<number> {
  try {
    const config = await loadConfig();
    return config.policy.permissionTimeoutMs + 5_000;
  } catch {
    return 60_000;
  }
}

export async function isFailOpen(): Promise<boolean> {
  try {
    const config = await loadConfig();
    return config.policy.failOpen;
  } catch {
    return true;
  }
}
