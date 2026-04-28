import type { ConfigT } from '../config/schema.js';
import { TmuxInjectStrategy, type InjectStrategy } from './tmux.js';

export function createInjectStrategy(config: ConfigT['inject']): InjectStrategy | null {
  if (!config.enabled) return null;
  const session = config.session ?? 'claude';
  return new TmuxInjectStrategy(session);
}

export { TmuxInjectStrategy } from './tmux.js';
export type { InjectStrategy } from './tmux.js';
