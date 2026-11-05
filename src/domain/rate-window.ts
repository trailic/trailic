/**
 * Counts per key in fixed one-minute windows, in this process's memory. The collector can't count in
 * the database (it mustn't wake it), so this holds per server instance: it stops a loop or a noisy
 * client, and a real flood is for the platform's firewall.
 */
export class RateWindow {
  private windowStart = 0;
  private counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Counts one more for this key, and says whether it fits. A new window forgets the last, so memory stays small. */
  take(key: string, now: number): boolean {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    if (start !== this.windowStart) {
      this.windowStart = start;
      this.counts.clear();
    }
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= this.limit;
  }
}
