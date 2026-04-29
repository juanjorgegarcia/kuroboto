import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  attachMarkerRelay,
  parseMarkerLine,
  MARKER_RE,
} from '../../src/daemon/sleepReportRelay.js';
import type { ChannelContext } from '../../src/channels/Channel.js';

class FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }
  push(stream: 'stdout' | 'stderr', chunk: string): void {
    this[stream].push(chunk);
  }
  end(stream: 'stdout' | 'stderr'): void {
    this[stream].push(null);
  }
}

interface Notif {
  msg: string;
  ctx: ChannelContext | undefined;
}

function setupRelay(slug = 'demo'): {
  child: FakeChild;
  notifs: Notif[];
  warns: { msg: string; meta?: Record<string, unknown> }[];
  debugs: { msg: string; meta?: Record<string, unknown> }[];
} {
  const child = new FakeChild();
  const notifs: Notif[] = [];
  const warns: { msg: string; meta?: Record<string, unknown> }[] = [];
  const debugs: { msg: string; meta?: Record<string, unknown> }[] = [];
  attachMarkerRelay(child as unknown as ChildProcess, {
    slug,
    notify: async (msg, ctx) => {
      notifs.push({ msg, ctx });
    },
    logger: {
      warn: (msg, meta) => warns.push({ msg, meta }),
      debug: (msg, meta) => debugs.push({ msg, meta }),
    },
  });
  return { child, notifs, warns, debugs };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('parseMarkerLine', () => {
  it('extracts the message from a well-formed marker', () => {
    expect(parseMarkerLine('[[KUROBOTO]] task 1 done: filter wired')).toBe(
      'task 1 done: filter wired',
    );
  });

  it('tolerates leading whitespace', () => {
    expect(parseMarkerLine('   [[KUROBOTO]] hello')).toBe('hello');
  });

  it('tolerates trailing whitespace (lazy capture)', () => {
    expect(parseMarkerLine('[[KUROBOTO]] hello   ')).toBe('hello');
  });

  it('returns null when the marker is not a line on its own', () => {
    expect(parseMarkerLine('I will emit a [[KUROBOTO]] marker now')).toBeNull();
  });

  it('returns null when the marker has no message', () => {
    expect(parseMarkerLine('[[KUROBOTO]]')).toBeNull();
    expect(parseMarkerLine('[[KUROBOTO]] ')).toBeNull();
  });

  it('returns null on a non-marker line', () => {
    expect(parseMarkerLine('Running tests…')).toBeNull();
    expect(parseMarkerLine('')).toBeNull();
  });

  it('case-sensitive and bracket-strict', () => {
    expect(parseMarkerLine('[[kuroboto]] x')).toBeNull();
    expect(parseMarkerLine('[KUROBOTO] x')).toBeNull();
  });

  it('exported regex matches the shape', () => {
    expect(MARKER_RE.test('[[KUROBOTO]] x')).toBe(true);
  });
});

describe('attachMarkerRelay', () => {
  it('relays a single marker line as a notify call with 📍 + slug ctx', async () => {
    const { child, notifs } = setupRelay('demo');
    child.push('stdout', '[[KUROBOTO]] task 1 done\n');
    await flush();
    expect(notifs).toEqual([
      { msg: '📍 task 1 done', ctx: { slug: 'demo', isSleep: true } },
    ]);
  });

  it('handles split chunks (a line that arrives in two writes)', async () => {
    const { child, notifs } = setupRelay();
    child.push('stdout', '[[KUROBOTO]] task ');
    await flush();
    expect(notifs).toEqual([]); // no newline yet
    child.push('stdout', '1 done\n');
    await flush();
    expect(notifs.map((n) => n.msg)).toEqual(['📍 task 1 done']);
  });

  it('handles multiple markers in one chunk', async () => {
    const { child, notifs } = setupRelay();
    child.push('stdout', '[[KUROBOTO]] a\n[[KUROBOTO]] b\n[[KUROBOTO]] c\n');
    await flush();
    expect(notifs.map((n) => n.msg)).toEqual(['📍 a', '📍 b', '📍 c']);
  });

  it('ignores non-matching lines (pass through to debug log only)', async () => {
    const { child, notifs, debugs } = setupRelay();
    child.push('stdout', 'Running tests…\nDone.\n[[KUROBOTO]] task 1 done\n');
    await flush();
    expect(notifs.map((n) => n.msg)).toEqual(['📍 task 1 done']);
    expect(debugs.length).toBeGreaterThanOrEqual(2);
    expect(debugs[0].msg).toMatch(/non-marker/);
  });

  it('reads stderr too', async () => {
    const { child, notifs } = setupRelay();
    child.push('stderr', '[[KUROBOTO]] err-side marker\n');
    await flush();
    expect(notifs.map((n) => n.msg)).toEqual(['📍 err-side marker']);
  });

  it('keeps slug context per session (no cross-talk between concurrent relays)', async () => {
    const a = setupRelay('aaa');
    const b = setupRelay('bbb');
    a.child.push('stdout', '[[KUROBOTO]] from-a\n');
    b.child.push('stdout', '[[KUROBOTO]] from-b\n');
    await flush();
    expect(a.notifs).toHaveLength(1);
    expect(a.notifs[0].ctx).toEqual({ slug: 'aaa', isSleep: true });
    expect(a.notifs[0].msg).toBe('📍 from-a');
    expect(b.notifs).toHaveLength(1);
    expect(b.notifs[0].ctx).toEqual({ slug: 'bbb', isSleep: true });
    expect(b.notifs[0].msg).toBe('📍 from-b');
  });

  it('a notify rejection logs a warn, does not crash the line handler', async () => {
    const child = new FakeChild();
    const warns: string[] = [];
    const failingNotify = vi.fn(async () => {
      throw new Error('telegram down');
    });
    attachMarkerRelay(child as unknown as ChildProcess, {
      slug: 'demo',
      notify: failingNotify,
      logger: {
        warn: (msg) => warns.push(msg),
      },
    });
    child.push('stdout', '[[KUROBOTO]] one\n[[KUROBOTO]] two\n');
    await flush();
    // Both lines processed (parser didn't crash); warns logged for both.
    expect(failingNotify).toHaveBeenCalledTimes(2);
    expect(warns.length).toBeGreaterThanOrEqual(2);
    expect(warns[0]).toMatch(/notify failed/);
  });

  it('no-op when stdout/stderr are null (defensive against custom stdio)', () => {
    const fake = { stdout: null, stderr: null } as unknown as ChildProcess;
    const notifs: string[] = [];
    expect(() =>
      attachMarkerRelay(fake, {
        slug: 's',
        notify: async (m) => {
          notifs.push(m);
        },
      }),
    ).not.toThrow();
  });
});
