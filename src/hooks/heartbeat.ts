import { readStdin, postToDaemon } from './util.js';

/** Shared body for every hook whose only purpose is to tell the daemon "user is active." */
export async function runHeartbeat(label: string): Promise<void> {
  try {
    JSON.parse(await readStdin());
  } catch {
    // payload may be empty/invalid; doesn't matter for a heartbeat
  }
  const result = await postToDaemon('/v1/heartbeat', { source: label }, 5_000);
  if (!result.ok) {
    process.stderr.write(`[kuroboto] heartbeat (${label}) failed: ${result.error}\n`);
  }
  process.exit(0);
}
