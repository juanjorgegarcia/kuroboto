import fs from 'node:fs';
import path from 'node:path';

export type CrashKind = 'uncaughtException' | 'unhandledRejection' | 'startupError';

export interface CrashLogDeps {
  // Sync writers — handlers must complete before `process.exit` returns,
  // and async fs operations are not guaranteed to flush in that window.
  appendSync?: (file: string, data: string) => void;
  mkdirSync?: (dir: string) => void;
  stderrWrite?: (msg: string) => void;
}

/**
 * Format and persist a crash entry. Sync I/O so the entry lands even if the
 * process is about to exit. Failures while writing the file fall back to
 * stderr (which `kuroboto start --detach` captures into the startup log).
 */
export function logCrashSync(
  crashLogFile: string,
  kind: CrashKind,
  err: unknown,
  deps: CrashLogDeps = {},
): void {
  const append = deps.appendSync ?? ((f, d) => fs.appendFileSync(f, d));
  const mkdir = deps.mkdirSync ?? ((d) => fs.mkdirSync(d, { recursive: true }));
  const stderr = deps.stderrWrite ?? ((m) => process.stderr.write(m));

  const ts = new Date().toISOString();
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  const line = `${ts} [${kind}] ${stack}\n`;

  try {
    mkdir(path.dirname(crashLogFile));
    append(crashLogFile, line);
  } catch (e) {
    stderr(`[kuroboto daemon] crash log write failed: ${(e as Error).message}\n`);
  }
  stderr(`[kuroboto daemon] ${kind}: ${stack}\n`);
}

/**
 * Wire up `uncaughtException` and `unhandledRejection` to log a structured
 * crash entry before exiting. Without this the process dies silently and the
 * daemon log shows nothing — the only evidence is the absence of a shutdown
 * message.
 */
export function installCrashHandlers(crashLogFile: string): void {
  process.on('uncaughtException', (err) => {
    logCrashSync(crashLogFile, 'uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logCrashSync(crashLogFile, 'unhandledRejection', reason);
    process.exit(1);
  });
}
