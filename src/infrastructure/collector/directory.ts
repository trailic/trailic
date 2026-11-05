import { cacheLife, cacheTag } from "next/cache";
import { collectorDirectory, type DirectoryEntry } from "@/application/sites";
import { withinTime } from "../db/answers";
import { db } from "../db/client";
import { SITES_TAG } from "../scheduling/scheduled-work";

const DAY_SECONDS = 86_400;
/** How long one server instance goes without looking again: a changed domain reaches it within this. */
const REMEMBER_MS = 60_000;
/** How long the collector waits for an answer: it would rather check later, at the flush, than keep a visitor's request open. */
const WAIT_MS = 1_500;
/** With nobody able to say, how long before one more request waits to find out. */
const UNKNOWN_FOR_MS = 30_000;

/** Every site's key and domains, kept outside the database. One read a day whatever the traffic, and whatever changes a site clears it at once. */
async function cachedDirectory(): Promise<DirectoryEntry[]> {
  "use cache: remote";
  cacheTag(SITES_TAG);
  cacheLife({ revalidate: DAY_SECONDS, expire: 7 * DAY_SECONDS });
  return collectorDirectory(db());
}

let known: { entries: DirectoryEntry[]; at: number } | undefined;
let unknownUntil = 0;

/**
 * What the collector knows about sites. Memory first, so a busy instance doesn't even pay for the
 * cache. A key memory doesn't hold is looked for at once, since it may be a site added a moment ago. A
 * null answer means nobody can say right now (a new deployment with the database asleep or down), and
 * the collector then keeps the events and leaves the check to the flush.
 */
export async function directoryForCollector(key?: string): Promise<readonly DirectoryEntry[] | null> {
  const now = Date.now();
  if (known && now - known.at < REMEMBER_MS && (!key || known.entries.some((entry) => entry.key === key))) return known.entries;
  if (now < unknownUntil) return known?.entries ?? null;
  const entries = await withinTime(cachedDirectory(), WAIT_MS).catch(() => null);
  if (entries) known = { entries, at: Date.now() };
  else unknownUntil = Date.now() + UNKNOWN_FOR_MS;
  return entries ?? known?.entries ?? null;
}
