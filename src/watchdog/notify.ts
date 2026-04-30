import fsp from 'node:fs/promises';
import { TOPICS_FILE } from '../config/paths.js';

/**
 * Minimal Telegram sender for the watchdog. Cannot reuse TelegramChannel
 * because the daemon may be dead and the watchdog must remain independent.
 * Best-effort: failures are reported via the optional log callback and
 * never thrown — the watchdog's state machine must keep running even if
 * Telegram is unreachable.
 */
export interface WatchdogNotifyOpts {
  token: string;
  chatId: number;
  forumMode: boolean;
  /** Telegram message body. */
  text: string;
  /** Per-call HTTP timeout. */
  timeoutMs?: number;
  /** Optional logger so callers can persist failures to watchdog.log. */
  log?: (msg: string) => void;
  /**
   * Override the on-disk topics file lookup — used in tests. Production
   * passes nothing so the standard TOPICS_FILE path is used.
   */
  topicsFile?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Send a one-shot Telegram notification from the watchdog. Routes to the
 * `kuroboto-system` topic when forumMode is on AND the topic was already
 * created (cached in topics.json); falls back to the main chat otherwise.
 *
 * Returns true on apparent success, false on any failure (network, HTTP,
 * Telegram API rejection). Never throws.
 */
export async function sendWatchdogNotification(opts: WatchdogNotifyOpts): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let threadId: number | undefined;
  if (opts.forumMode) {
    threadId = await readSystemThreadId(opts.topicsFile ?? TOPICS_FILE, opts.log);
  }

  try {
    const body: Record<string, unknown> = { chat_id: opts.chatId, text: opts.text };
    if (threadId !== undefined) body.message_thread_id = threadId;

    const url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      opts.log?.(`telegram sendMessage HTTP ${res.status}`);
      return false;
    }
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; description?: string }
      | null;
    if (!json?.ok) {
      opts.log?.(`telegram sendMessage rejected: ${json?.description ?? 'unknown'}`);
      return false;
    }
    return true;
  } catch (e) {
    opts.log?.(`telegram sendMessage failed: ${(e as Error).message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the cached `kuroboto-system` thread id from topics.json. Returns
 * undefined when the file doesn't exist, is malformed, or doesn't contain
 * a system topic entry — caller falls back to the main chat in those cases.
 */
async function readSystemThreadId(file: string, log?: (m: string) => void): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log?.(`topics.json read failed: ${(e as Error).message}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log?.(`topics.json malformed: ${(e as Error).message}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const v = (parsed as Record<string, unknown>)['kuroboto-system'];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
