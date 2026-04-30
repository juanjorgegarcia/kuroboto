import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'kuroboto');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
export const DAEMON_SENTINEL_FILE = path.join(CONFIG_DIR, 'daemon.pid.json');
export const LOG_DIR = path.join(CONFIG_DIR, 'logs');
export const AUDIT_FILE = path.join(CONFIG_DIR, 'audit.jsonl');
export const TOPICS_FILE = path.join(CONFIG_DIR, 'topics.json');
export const STARTUP_LOG_FILE = path.join(CONFIG_DIR, 'daemon.startup.log');
export const CRASH_LOG_FILE = path.join(CONFIG_DIR, 'daemon.crash.log');
export const WATCHDOG_PID_FILE = path.join(CONFIG_DIR, 'watchdog.pid');
export const WATCHDOG_LOG_FILE = path.join(CONFIG_DIR, 'watchdog.log');
