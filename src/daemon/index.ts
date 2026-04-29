import { loadConfig } from '../config/load.js';
import { startDaemon } from './lifecycle.js';
import { CRASH_LOG_FILE } from '../config/paths.js';
import { installCrashHandlers, logCrashSync } from './crashHandlers.js';

installCrashHandlers(CRASH_LOG_FILE);

async function main(): Promise<void> {
  const config = await loadConfig();
  await startDaemon(config);
  // The daemon hooks into SIGTERM/SIGINT; this promise never resolves naturally.
  await new Promise<void>(() => {});
}

main().catch((e) => {
  logCrashSync(CRASH_LOG_FILE, 'startupError', e);
  process.exit(1);
});
