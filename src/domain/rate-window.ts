const windowOf = (now: number, windowMs: number) => Math.floor(now / windowMs) * windowMs;

/**
 * Counts per key in fixed one-minute windows, in this process's memory. The collector can't count in
 * the database (it mustn't wake it), so this holds per server instance: it keeps a flood out of the
 * queue, and what a flood costs before it gets here is for the platform's firewall.
 */
export class RateWindow {
  private windowStart = 0;
  private counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** A new window forgets the last, so memory stays small. */
  private enter(now: number): void {
    const start = windowOf(now, this.windowMs);
    if (start === this.windowStart) return;
    this.windowStart = start;
    this.counts.clear();
  }

  /** Counts one more for this key, and says whether it fits. */
  take(key: string, now: number): boolean {
    this.enter(now);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= this.limit;
  }

  /** Whether this key has used all it may, without counting anything. */
  full(key: string, now: number): boolean {
    this.enter(now);
    return (this.counts.get(key) ?? 0) >= this.limit;
  }
}

/**
 * How many requests each limit turned away in a minute, and nothing else about them. A refused event
 * is lost, so this is all that's left of it: one report a minute at most, however big the flood.
 */
export class RefusalTally<Limit extends string> {
  private windowStart = 0;
  private counts: Partial<Record<Limit, number>> = {};

  constructor(
    private readonly report: (counts: Partial<Record<Limit, number>>) => void,
    private readonly windowMs = 60_000,
  ) {}

  /** Reports a finished window that has anything in it, once the clock has moved on. */
  settle(now: number): void {
    const start = windowOf(now, this.windowMs);
    if (start === this.windowStart) return;
    this.windowStart = start;
    if (Object.keys(this.counts).length > 0) this.report(this.counts);
    this.counts = {};
  }

  add(limit: Limit, now: number): void {
    this.settle(now);
    this.counts[limit] = (this.counts[limit] ?? 0) + 1;
  }
}
