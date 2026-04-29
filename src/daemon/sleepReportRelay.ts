import readline from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ChannelContext } from '../channels/Channel.js';

// Sleep claude emits structured progress markers on stdout for mid-flight
// visibility (Spec J3). Format: a single line by itself, exact prefix
// `[[KUROBOTO]]`, then whitespace, then a one-line message. Lazy capture +
// `\s*$` strips trailing whitespace.
export const MARKER_RE = /^\s*\[\[KUROBOTO\]\]\s+(.+?)\s*$/;

export interface MarkerRelayLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

export interface MarkerRelayDeps {
  slug: string;
  notify: (msg: string, ctx?: ChannelContext) => Promise<void>;
  logger?: MarkerRelayLogger;
}

export function parseMarkerLine(line: string): string | null {
  const m = MARKER_RE.exec(line);
  return m ? m[1] : null;
}

export function attachMarkerRelay(child: ChildProcess, deps: MarkerRelayDeps): void {
  if (child.stdout) attachStream(child.stdout, deps);
  if (child.stderr) attachStream(child.stderr, deps);
}

function attachStream(stream: Readable, deps: MarkerRelayDeps): void {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    try {
      const marker = parseMarkerLine(line);
      if (marker !== null) {
        void deps.notify(`📍 ${marker}`, { slug: deps.slug, isSleep: true }).catch((e) => {
          deps.logger?.warn('marker relay notify failed', {
            slug: deps.slug,
            err: (e as Error).message,
          });
        });
      } else if (deps.logger?.debug) {
        deps.logger.debug('sleep stdout (non-marker)', { slug: deps.slug, line });
      }
    } catch (e) {
      deps.logger?.warn('marker relay handler error', {
        slug: deps.slug,
        err: (e as Error).message,
      });
    }
  });
}
