import { describe, it, expect } from 'vitest';
import { parseOpts } from '../../src/cli/claude.js';

describe('parseOpts', () => {
  it('no flags → forward = args', () => {
    expect(parseOpts(['--version'])).toEqual({ tmux: false, name: undefined, forward: ['--version'] });
  });

  it('--tmux strips and sets flag', () => {
    expect(parseOpts(['--tmux'])).toEqual({ tmux: true, name: undefined, forward: [] });
  });

  it('--name <slug> consumes both args', () => {
    expect(parseOpts(['--name', 'foo'])).toEqual({ tmux: false, name: 'foo', forward: [] });
  });

  it('--name=<slug> single-arg form', () => {
    expect(parseOpts(['--name=foo'])).toEqual({ tmux: false, name: 'foo', forward: [] });
  });

  it('combines --tmux and --name in either order', () => {
    expect(parseOpts(['--tmux', '--name', 'foo'])).toEqual({ tmux: true, name: 'foo', forward: [] });
    expect(parseOpts(['--name', 'foo', '--tmux'])).toEqual({ tmux: true, name: 'foo', forward: [] });
  });

  it('forwards unknown flags as-is', () => {
    expect(parseOpts(['--name', 'foo', '--version'])).toEqual({ tmux: false, name: 'foo', forward: ['--version'] });
  });

  it('stops at the first non-recognised arg (no reordering)', () => {
    // `--tmux` after a positional is treated as a forwarded arg, not a kuroboto flag.
    expect(parseOpts(['hello', '--tmux'])).toEqual({ tmux: false, name: undefined, forward: ['hello', '--tmux'] });
  });
});
