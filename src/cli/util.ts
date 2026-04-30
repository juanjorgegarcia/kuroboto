import fsp from 'node:fs/promises';
import { PID_FILE } from '../config/paths.js';
import { loadConfig } from '../config/load.js';
import type {
  StatusData,
} from './statusFormat.js';

export async function readPid(): Promise<number | null> {
  try {
    const raw = await fsp.readFile(PID_FILE, 'utf-8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Narrowed health response — liveness only. Gaming/mode/pending moved to /v1/status. */
export interface HealthData {
  ok: boolean;
  uptimeSec: number;
}

export type HealthResult =
  | { ok: true; data: HealthData }
  | { ok: false; error: string };

export async function checkHealth(timeoutMs = 2_000): Promise<HealthResult> {
  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/health`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as HealthData;
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: (e as Error).message };
  }
}

export type StatusResult =
  | { ok: true; data: StatusData }
  | { ok: false; error: string; errorCode?: string };

export async function fetchStatus(timeoutMs = 3_000): Promise<StatusResult> {
  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${config.daemon.port}/v1/status`, {
      signal: ctrl.signal,
      headers: { 'X-Kuroboto-Token': config.daemon.authToken },
    });
    clearTimeout(timer);
    if (res.status === 401) {
      return { ok: false, error: 'auth failed (check config token)', errorCode: 'AUTH' };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, errorCode: `HTTP_${res.status}` };
    }
    let data: StatusData;
    try {
      data = (await res.json()) as StatusData;
    } catch {
      return { ok: false, error: 'malformed response from daemon', errorCode: 'MALFORMED' };
    }
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error & { code?: string };
    return { ok: false, error: err.message, errorCode: err.code };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { type StatusData };
