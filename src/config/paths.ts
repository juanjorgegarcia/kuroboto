import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'kuroboto');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
export const LOG_DIR = path.join(CONFIG_DIR, 'logs');
export const AUDIT_FILE = path.join(CONFIG_DIR, 'audit.jsonl');
