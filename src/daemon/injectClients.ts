import path from 'node:path';

export interface ClientInfo {
  slug: string;
  pid: number;
  cwd: string;
  localPort: number;
  registeredAt: number;
}

export interface ClientListEntry extends ClientInfo {
  sessions: string[];
}

/**
 * In-memory registry of `kuroboto claude` CLI processes that own a PTY and
 * accept inject calls. State is rebuilt from CLI re-registrations after a
 * daemon restart (CLIs `fs.watch` the daemon-pid sentinel).
 */
export class InjectClients {
  private readonly clients = new Map<string, ClientInfo>();
  private readonly sessionToSlug = new Map<string, string>();

  register(info: ClientInfo): void {
    const existing = this.clients.get(info.slug);
    if (existing && existing.pid !== info.pid) {
      throw new Error(`slug "${info.slug}" already in use by PID ${existing.pid}`);
    }
    this.clients.set(info.slug, info);
  }

  deregister(slug: string): boolean {
    const had = this.clients.delete(slug);
    for (const [sid, s] of this.sessionToSlug) {
      if (s === slug) this.sessionToSlug.delete(sid);
    }
    return had;
  }

  bindSessionToSlug(sessionId: string, slug: string): void {
    if (!this.clients.has(slug)) {
      throw new Error(`cannot bind session: unknown slug "${slug}"`);
    }
    this.sessionToSlug.set(sessionId, slug);
  }

  /**
   * Late-bind on first hook event from a session: if a registered CLI has the
   * same `cwd` and this session isn't already bound, link them. No-op if the
   * session is bound already or no CLI matches.
   */
  bindSessionByCwd(sessionId: string, cwd: string): void {
    if (this.sessionToSlug.has(sessionId)) return;
    for (const [slug, info] of this.clients) {
      if (samePath(info.cwd, cwd)) {
        this.sessionToSlug.set(sessionId, slug);
        return;
      }
    }
  }

  lookupBySession(sessionId: string): ClientInfo | null {
    const slug = this.sessionToSlug.get(sessionId);
    if (!slug) return null;
    return this.clients.get(slug) ?? null;
  }

  has(slug: string): boolean {
    return this.clients.has(slug);
  }

  list(): ClientListEntry[] {
    return Array.from(this.clients.entries()).map(([slug, info]) => {
      const sessions: string[] = [];
      for (const [sid, s] of this.sessionToSlug) {
        if (s === slug) sessions.push(sid);
      }
      return { ...info, sessions };
    });
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
