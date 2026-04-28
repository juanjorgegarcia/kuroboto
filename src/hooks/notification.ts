import { readStdin, postToDaemon } from './util.js';

export async function run(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch (e) {
    process.stderr.write(`[kuroboto] notification: bad payload: ${(e as Error).message}\n`);
    process.exit(0);
  }
  const result = await postToDaemon('/v1/notify', payload, 5_000);
  if (!result.ok) {
    process.stderr.write(`[kuroboto] notification failed: ${result.error}\n`);
  }
  process.exit(0);
}
