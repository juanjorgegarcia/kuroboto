import type { ConfigT } from '../config/schema.js';
import { TmuxInjectStrategy, type InjectStrategy } from './tmux.js';

export function createInjectStrategy(config: ConfigT['inject']): InjectStrategy | null {
  if (!config.enabled) return null;
  // PTY mode routes via daemon → registered CLI's local server, not via this strategy.
  if (config.strategy === 'pty') return null;
  const session = config.session ?? 'claude';
  return new TmuxInjectStrategy(session);
}

export { TmuxInjectStrategy } from './tmux.js';
export type { InjectStrategy } from './tmux.js';
