import fsp from 'node:fs/promises';
import { PID_FILE } from '../config/paths.js';
import { loadConfig } from '../config/load.js';

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

export interface HealthData {
  ok: boolean;
  uptimeSec: number;
  pending: number;
  pendingNotifications?: number;
  mode?: 'here' | 'away';
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
