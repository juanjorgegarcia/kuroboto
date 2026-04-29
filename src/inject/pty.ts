import type { ClientInfo } from '../daemon/injectClients.js';

export interface InjectViaPtyOpts {
  authToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * POST the reply text to a CLI process's `/inject` endpoint over loopback.
 * Throws with a human-readable reason on any non-OK outcome (network refused,
 * 4xx/5xx, timeout). The daemon caller treats any throw as "drop client +
 * fall back to Telegram echo".
 */
export async function injectViaPty(
  client: ClientInfo,
  text: string,
  opts: InjectViaPtyOpts,
): Promise<void> {
  const url = `http://127.0.0.1:${client.localPort}/inject`;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kuroboto-Token': opts.authToken,
      },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error & { name?: string };
    if (err.name === 'AbortError') {
      throw new Error(`inject timed out after ${timeoutMs}ms`);
    }
    throw new Error(`inject POST failed: ${err.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).trim();
    } catch {
      // body unreadable; fall through with empty
    }
    throw new Error(`inject POST failed: HTTP ${res.status}${body ? ` ${body}` : ''}`);
  }
}
