import { describe, it, expect } from 'vitest';
import { InjectClients, type ClientInfo } from '../../src/daemon/injectClients.js';

function makeInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    slug: 'foo',
    pid: 1234,
    cwd: '/x/foo',
    localPort: 50000,
    registeredAt: Date.now(),
    ...overrides,
  };
}

describe('InjectClients', () => {
  it('register stores entry; lookup misses without binding', () => {
    const c = new InjectClients();
    c.register(makeInfo());
    expect(c.has('foo')).toBe(true);
    expect(c.lookupBySession('sess-1')).toBeNull();
  });

  it('register: same slug + same pid is idempotent (re-register on daemon restart)', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo', pid: 100, localPort: 50000 }));
    c.register(makeInfo({ slug: 'foo', pid: 100, localPort: 50001 }));
    expect(c.list()[0].localPort).toBe(50001);
  });

  it('register: same slug + different pid throws (collision)', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo', pid: 100 }));
    expect(() => c.register(makeInfo({ slug: 'foo', pid: 200 }))).toThrow(/already in use by PID 100/);
  });

  it('deregister removes entry and clears all bound sessions', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo' }));
    c.bindSessionToSlug('sess-a', 'foo');
    c.bindSessionToSlug('sess-b', 'foo');
    expect(c.deregister('foo')).toBe(true);
    expect(c.has('foo')).toBe(false);
    expect(c.lookupBySession('sess-a')).toBeNull();
    expect(c.lookupBySession('sess-b')).toBeNull();
  });

  it('deregister returns false when slug unknown', () => {
    const c = new InjectClients();
    expect(c.deregister('nope')).toBe(false);
  });

  it('bindSessionToSlug throws when slug not registered', () => {
    const c = new InjectClients();
    expect(() => c.bindSessionToSlug('sess-x', 'ghost')).toThrow(/unknown slug/);
  });

  it('lookupBySession returns full client info after binding', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo', localPort: 50123 }));
    c.bindSessionToSlug('sess-1', 'foo');
    const info = c.lookupBySession('sess-1');
    expect(info).not.toBeNull();
    expect(info!.localPort).toBe(50123);
  });

  it('bindSessionByCwd matches a registered client by resolved path', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo', cwd: '/x/foo' }));
    c.bindSessionByCwd('sess-1', '/x/foo/.');
    expect(c.lookupBySession('sess-1')?.slug).toBe('foo');
  });

  it('bindSessionByCwd is no-op if session already bound', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo', cwd: '/x/foo' }));
    c.register(makeInfo({ slug: 'bar', cwd: '/x/bar', pid: 999 }));
    c.bindSessionToSlug('sess-1', 'bar');
    c.bindSessionByCwd('sess-1', '/x/foo');
    expect(c.lookupBySession('sess-1')?.slug).toBe('bar');
  });

  it('bindSessionByCwd is no-op if no CLI matches', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo', cwd: '/x/foo' }));
    c.bindSessionByCwd('sess-1', '/x/elsewhere');
    expect(c.lookupBySession('sess-1')).toBeNull();
  });

  it('list returns clients with their bound sessions', () => {
    const c = new InjectClients();
    c.register(makeInfo({ slug: 'foo', cwd: '/x/foo' }));
    c.register(makeInfo({ slug: 'bar', cwd: '/x/bar', pid: 999 }));
    c.bindSessionToSlug('sess-a', 'foo');
    c.bindSessionToSlug('sess-b', 'foo');
    c.bindSessionToSlug('sess-c', 'bar');
    const list = c.list();
    const foo = list.find((e) => e.slug === 'foo')!;
    const bar = list.find((e) => e.slug === 'bar')!;
    expect(foo.sessions.sort()).toEqual(['sess-a', 'sess-b']);
    expect(bar.sessions).toEqual(['sess-c']);
  });
});
