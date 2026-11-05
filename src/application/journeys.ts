import { sql } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { rowsOf } from "@/infrastructure/db/rows";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { lastWrittenAt } from "./overview";
import type { Period } from "./time-range";

/** How many pages after the first a journey follows. */
export const JOURNEY_DEPTH = 3;
const MINUTES_APART = 30;
const MOST_JOURNEYS = 20;

export interface Journey {
  /** The pages that came next; empty for those who stopped there. */
  next: string[];
  visits: number;
}

export interface JourneysReport {
  from: string;
  to: string;
  start: string;
  timezone: "UTC";
  lastWrittenAt: Date | null;
  /** Visitors who reached the page, once per visitor per day. */
  visits: number;
  journeys: Journey[];
}

/**
 * The most common paths onward from a page: for each visitor's first time on it each day, the next
 * pages within half an hour. Follows the visitor's hash, not the person: a journey happens on one
 * device on one day, and anonymous visitors are most of them.
 */
async function journeysFrom(tx: Database, siteId: string, startPath: string, period: Pick<Period, "start" | "end">): Promise<{ next: string[]; visits: number; total: number }[]> {
  return rowsOf(tx, sql`
    with starts as (
      select distinct on (visitor, (at at time zone 'UTC')::date) visitor, at
      from event
      where site_id = ${siteId}::uuid and kind = 'page' and path = ${startPath} and visitor is not null and at >= ${period.start}::timestamptz and at < ${period.end}::timestamptz
      order by visitor, (at at time zone 'UTC')::date, at
    ),
    onward as (
      select s.visitor, s.at as started, coalesce((
        select jsonb_agg(following.path order by following.at) from (
          select e.path, e.at from event e
          where e.site_id = ${siteId}::uuid and e.kind = 'page' and e.visitor = s.visitor and e.at > s.at and e.at <= s.at + make_interval(mins => ${MINUTES_APART})
          order by e.at limit ${JOURNEY_DEPTH}
        ) as following
      ), '[]'::jsonb) as next
      from starts s
    )
    select next, count(*)::int as visits, (sum(count(*)) over ())::int as total
    from onward group by next order by visits desc, next limit ${MOST_JOURNEYS}`);
}

export async function journeysOf(db: Database, workspaceId: string, input: { siteId: string; startPath: string; period: Period }): Promise<JourneysReport> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await journeysFrom(tx, input.siteId, input.startPath, input.period);
    return {
      from: input.period.from,
      to: input.period.to,
      start: input.startPath,
      timezone: "UTC",
      lastWrittenAt: await lastWrittenAt(tx, input.siteId),
      visits: rows[0]?.total ?? 0,
      journeys: rows.map(({ next, visits }) => ({ next, visits })),
    };
  });
}
