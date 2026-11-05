import { sql } from "drizzle-orm";
import { cohortTable, weeksEndingAt, type CohortCell, type CohortRow } from "@/domain/cohorts";
import type { Database } from "@/infrastructure/db/client";
import { rowsOf } from "@/infrastructure/db/rows";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { lastWrittenAt } from "./overview";

export const DEFAULT_WEEKS = 8;
export const MOST_WEEKS = 26;

export interface RetentionInput {
  siteId: string;
  weeks: number;
  /** What counts as coming back: this event, or anything at all. */
  eventName?: string;
  now: Date;
}

export interface RetentionTable {
  weeks: number;
  /** What was counted as coming back. */
  returnedBy: string;
  timezone: "UTC";
  lastWrittenAt: Date | null;
  cohorts: CohortRow[];
}

const mondayOf = (column: ReturnType<typeof sql.raw>) => sql`to_char(date_trunc('week', ${column} at time zone 'UTC'), 'YYYY-MM-DD')`;

/**
 * Identified people only, by the week a site first identified them. It has to be: an anonymous hash
 * rotates every day, by design, so nobody anonymous can be recognised a week later. Comes from raw
 * rows, so it reaches back as far as the site keeps them.
 */
export async function retentionOf(db: Database, workspaceId: string, { siteId, weeks, eventName, now }: RetentionInput): Promise<RetentionTable> {
  const mondays = weeksEndingAt(now, weeks);
  const start = `${mondays[0]}T00:00:00.000Z`;
  return withWorkspace(db, workspaceId, async (tx) => {
    const sizes = await rowsOf<{ cohort: string; people: number }>(tx, sql`
      select ${mondayOf(sql.raw("first_seen_at"))} as cohort, count(*)::int as people
      from person where site_id = ${siteId}::uuid and first_seen_at >= ${start}::timestamptz group by 1`);
    const cells = await rowsOf<CohortCell>(tx, sql`
      with activity as (
        select distinct user_id, date_trunc('week', at at time zone 'UTC') as week
        from event
        where site_id = ${siteId}::uuid and at >= ${start}::timestamptz and user_id is not null ${eventName ? sql`and kind = 'event' and name = ${eventName}` : sql``}
      )
      select ${mondayOf(sql.raw("p.first_seen_at"))} as cohort, (extract(epoch from a.week - date_trunc('week', p.first_seen_at at time zone 'UTC')) / 604800)::int as "offset", count(*)::int as people
      from person p join activity a on a.user_id = p.user_id
      where p.site_id = ${siteId}::uuid and p.first_seen_at >= ${start}::timestamptz and a.week >= date_trunc('week', p.first_seen_at at time zone 'UTC')
      group by 1, 2`);
    return {
      weeks,
      returnedBy: eventName ? `event ${eventName}` : "any activity",
      timezone: "UTC",
      lastWrittenAt: await lastWrittenAt(tx, siteId),
      cohorts: cohortTable(mondays, new Map(sizes.map(({ cohort, people }) => [cohort, people])), cells),
    };
  });
}
