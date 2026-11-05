import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { rowsOf } from "./rows";

// Raw events' monthly partitions. Trusted path: the app role can't create or drop tables.

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** Makes the partitions these moments need: the function also gives each its row-level security, policy and grants. */
export async function ensureEventPartitions(db: Database, moments: readonly string[]): Promise<void> {
  const months = [...new Set(moments.map(monthStart))];
  for (const month of months) await db.execute(sql`select ensure_event_partition(${month}::date)`);
}

/** Which months have a partition, oldest first, as their first day. */
export async function eventPartitionMonths(db: Database): Promise<string[]> {
  const rows = await rowsOf<{ name: string }>(db, sql`select child.relname as name from pg_inherits join pg_class child on child.oid = inhrelid join pg_class parent on parent.oid = inhparent where parent.relname = 'event' order by 1`);
  return rows.map(({ name }) => name.replace(/^event_(\d{4})_(\d{2})$/, "$1-$2-01"));
}

/** Drops a month's raw events at once, which is the point of partitions: no dead rows left for the database to clean up. */
export async function dropEventPartition(db: Database, month: string): Promise<void> {
  await db.execute(sql.raw(`drop table if exists event_${month.slice(0, 7).replace("-", "_")}`));
}

/** The month after, as its first day. */
export function monthAfter(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10);
}
