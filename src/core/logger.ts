import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 3;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const REDACTED_KEYS = new Set(['token', 'authToken', 'chatId', 'chat_id', 'tool_input']);

function redact(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACTED_KEYS.has(k) ? '<redacted>' : v;
  }
  return out;
}

async function rotateIfNeeded(file: string): Promise<void> {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return;
  }
  if (stat.size < MAX_BYTES) return;

  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    const dst = `${file}.${i + 1}`;
    try {
      await fsp.rename(src, dst);
    } catch {
      // ignore — file may not exist yet
    }
  }
  try {
    await fsp.rename(file, `${file}.1`);
  } catch {
    // ignore
  }
}

export function createLogger(logDir: string, name = 'daemon'): Logger {
  const file = path.join(logDir, `${name}.log`);
  fs.mkdirSync(logDir, { recursive: true });

  let writePromise: Promise<void> = Promise.resolve();

  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...redact(fields),
    });
    writePromise = writePromise
      .then(() => rotateIfNeeded(file))
      .then(() => fsp.appendFile(file, entry + '\n'))
      .catch(() => {
        // last-resort: stderr
        process.stderr.write(`[logger] ${entry}\n`);
      });
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
