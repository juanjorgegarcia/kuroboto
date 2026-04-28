import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../config/paths.js';

export type Mode = 'here' | 'away';

const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

export async function loadMode(): Promise<Mode> {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === 'away' ? 'away' : 'here';
  } catch {
    return 'here';
  }
}

export async function saveMode(mode: Mode): Promise<void> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify({ mode }, null, 2));
}
