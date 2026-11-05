import { and, eq, lt, sql } from "drizzle-orm";
import { dayOf } from "@/domain/collected";
import type { Database } from "@/infrastructure/db/client";
import { dropEventPartition, eventPartitionMonths, monthAfter } from "@/infrastructure/db/partitions";
import { rowsOf } from "@/infrastructure/db/rows";
import { erasedPerson, flushedBatch, person, site } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";

const DAY_MS = 86_400_000;
/** A week and a day: the longest a buffer can hold a batch, and a margin. Past that it can't come again. */
const LEDGER_DAYS = 8;

export interface RetentionReport {
  partitionsDropped: number;
  rowsDeleted: number;
  peopleForgotten: number;
}

/** The first day to keep: whole days go, so a day is either all there or not there at all, and rollups can be rebuilt from what remains. */
const firstKeptDay = (now: Date, retentionDays: number) => dayOf(new Date(now.getTime() - retentionDays * DAY_MS));

/** Months no site keeps anything from. Dropping one is instant, and leaves nothing behind to clean up. */
async function dropWholeMonths(db: Database, oldestKept: string): Promise<number> {
  let dropped = 0;
  for (const month of await eventPartitionMonths(db)) {
    if (monthAfter(month) > oldestKept) continue;
    await dropEventPartition(db, month);
    dropped += 1;
  }
  return dropped;
}

async function trimSite(db: Database, { id, workspaceId, retentionDays }: { id: string; workspaceId: string; retentionDays: number }, now: Date): Promise<{ rows: number; people: number }> {
  const firstDay = firstKeptDay(now, retentionDays);
  return withWorkspace(db, workspaceId, async (tx) => {
    const deleted = await rowsOf<{ count: number }>(tx, sql`with gone as (delete from event where site_id = ${id}::uuid and at < (${firstDay}::date::timestamp at time zone 'UTC') returning 1) select count(*)::int as count from gone`);
    const forgotten = await tx
      .delete(person)
      .where(and(eq(person.siteId, id), lt(person.lastSeenAt, new Date(`${firstDay}T00:00:00Z`))))
      .returning({ id: person.userId });
    return { rows: deleted[0].count, people: forgotten.length };
  });
}

/**
 * What each site said it keeps, and no more. Rollups stay: they hold no rows about anyone. Someone
 * unseen for the retention period is forgotten too, traits and all; if they come back, they're new.
 */
export async function applyRetention(db: Database, now: Date): Promise<RetentionReport> {
  const sites = await db.select({ id: site.id, workspaceId: site.workspaceId, retentionDays: site.retentionDays }).from(site);
  const report: RetentionReport = { partitionsDropped: 0, rowsDeleted: 0, peopleForgotten: 0 };
  const expired = new Date(now.getTime() - LEDGER_DAYS * DAY_MS);
  await db.delete(flushedBatch).where(lt(flushedBatch.flushedAt, expired));
  await db.delete(erasedPerson).where(lt(erasedPerson.erasedAt, expired));
  if (sites.length === 0) return report;
  const oldestKept = sites.map(({ retentionDays }) => firstKeptDay(now, retentionDays)).sort()[0];
  report.partitionsDropped = await dropWholeMonths(db, oldestKept);
  for (const one of sites) {
    const { rows, people } = await trimSite(db, one, now);
    report.rowsDeleted += rows;
    report.peopleForgotten += people;
  }
  return report;
}

