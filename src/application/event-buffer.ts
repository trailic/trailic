import type { BufferedBatch } from "@/domain/collected";

/**
 * Where events wait for the database. The collector writes here on every request and never touches
 * Postgres; the scheduled flush empties it in batches. A buffer delivers at least once and keeps what
 * isn't acknowledged, so self-hosters can swap it for anything that does the same.
 */
export interface EventBuffer {
  /** Keeps a batch durably, or throws. When this returns, the event can't be lost by a crash here. */
  append(batch: BufferedBatch): Promise<void>;
  /** Up to `max` batches, hidden from other flushes for a while. An empty answer must not wake the database. */
  claim(max: number): Promise<Claim[]>;
}

export interface Claim {
  /** As stored: checked before it is believed. */
  batch: unknown;
  /** How many times this batch has been handed out, this time included. */
  deliveries: number;
  /** It's written: never deliver it again. A failure here is harmless, since writing it twice writes it once. */
  done(): Promise<void>;
  /** It wasn't written: deliver it again later. */
  giveBack(): Promise<void>;
}
