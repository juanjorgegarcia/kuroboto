import type { Decision } from '../core/types.js';
import { readStdin, postToDaemon, getPermissionTimeoutMs, isFailOpen } from './util.js';

export async function run(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch (e) {
    process.stderr.write(`[kuroboto] pre-tool: bad payload: ${(e as Error).message}\n`);
    process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'hook parse error' }));
    process.exit(0);
  }
  const timeoutMs = await getPermissionTimeoutMs();
  const result = await postToDaemon<Decision>('/v1/permission', payload, timeoutMs);
  if (result.ok) {
    process.stdout.write(JSON.stringify(result.data));
    process.exit(0);
  }
  process.stderr.write(`[kuroboto] pre-tool failed: ${result.error}\n`);
  const failOpen = await isFailOpen();
  const fallback: Decision = failOpen
    ? { decision: 'allow', reason: `kuroboto unreachable (fail-open): ${result.error}` }
    : { decision: 'deny', reason: `kuroboto unreachable: ${result.error}` };
  process.stdout.write(JSON.stringify(fallback));
  process.exit(0);
}
