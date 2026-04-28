import { loadConfig } from '../config/load.js';
import { startDaemon } from './lifecycle.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  await startDaemon(config);
  // The daemon hooks into SIGTERM/SIGINT; this promise never resolves naturally.
  await new Promise<void>(() => {});
}

main().catch((e) => {
  console.error(`[kuroboto daemon] fatal: ${(e as Error).message}`);
  process.exit(1);
});
