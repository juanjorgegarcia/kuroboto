export interface GamingSnapshot {
  active: boolean;
  until: number | null;
}

export class GamingState {
  private active = false;
  private until: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  snapshot(): GamingSnapshot {
    return { active: this.active, until: this.until };
  }

  arm(durationMs?: number): void {
    if (durationMs !== undefined && durationMs <= 0) {
      throw new Error(`gaming arm: durationMs must be > 0 (got ${durationMs})`);
    }
    this.clearTimer();
    this.active = true;
    if (durationMs === undefined) {
      this.until = null;
      return;
    }
    this.until = Date.now() + durationMs;
    this.timer = setTimeout(() => {
      this.active = false;
      this.until = null;
      this.timer = null;
    }, durationMs);
  }

  cancel(): void {
    this.clearTimer();
    this.active = false;
    this.until = null;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

const DURATION_RE = /^(\d+)([smh])$/;

export function parseDuration(s: string): number {
  const m = DURATION_RE.exec(s);
  if (!m) throw new Error(`invalid duration: ${s} (use 30s, 15m, 2h)`);
  const n = Number(m[1]);
  if (n <= 0) throw new Error(`invalid duration: ${s} (must be > 0)`);
  const mult = { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
  return n * mult;
}
