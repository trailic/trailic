import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { rowsOf } from "@/infrastructure/db/rows";

export interface SiteDay {
  siteId: string;
  /** YYYY-MM-DD, UTC. */
  day: string;
}

const DAY_MS = 86_400_000;

const siteList = (siteIds: readonly string[]) => sql.join(siteIds.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * One day's raw rows, each with who it counts as: someone identified is one person, whatever they
 * use. The bounds are written out so the database reads one partition's index: joined from a list
 * of days, it can't tell which partitions matter, and it scans a month of events for each flush.
 */
function dayRows(siteIds: readonly string[], day: string) {
  const start = new Date(`${day}T00:00:00.000Z`);
  return sql`
    select e.site_id, ${day}::date as day, e.kind, e.path, e.name, e.referrer, e.utm_source, e.utm_medium, e.utm_campaign, e.utm_term, e.utm_content, e.country, e.device, e.browser, e.os, e.value,
      coalesce(e.user_id, e.visitor::text) as who
    from event e
    where e.site_id in (${siteList(siteIds)}) and e.at >= ${start.toISOString()}::timestamptz and e.at < ${new Date(start.getTime() + DAY_MS).toISOString()}::timestamptz`;
}

const siteTotals = (rows: SQL) => sql`
  insert into daily_site (site_id, day, visitors, page_views, events, bounces)
  select site_id, day, count(*) filter (where pages > 0), coalesce(sum(pages), 0), coalesce(sum(custom), 0), count(*) filter (where pages = 1)
  from (
    select site_id, day, who, count(*) filter (where kind = 'page') as pages, count(*) filter (where kind = 'event') as custom
    from (${rows}) e group by site_id, day, who
  ) per_person
  group by site_id, day`;

const dimensions = (rows: SQL) => sql`
  insert into daily_dimension (site_id, day, dimension, value, count, visitors)
  select e.site_id, e.day, d.dimension, d.value, count(*), count(distinct e.who)
  from (${rows}) e
  cross join lateral (values
    ('page', case when e.kind = 'page' then e.path end),
    ('referrer', case when e.kind = 'page' then coalesce(e.referrer, '(direct)') end),
    ('utm_source', case when e.kind = 'page' then e.utm_source end),
    ('utm_medium', case when e.kind = 'page' then e.utm_medium end),
    ('utm_campaign', case when e.kind = 'page' then e.utm_campaign end),
    ('utm_term', case when e.kind = 'page' then e.utm_term end),
    ('utm_content', case when e.kind = 'page' then e.utm_content end),
    ('country', case when e.kind = 'page' then coalesce(e.country, '(unknown)') end),
    ('device', case when e.kind = 'page' then coalesce(e.device, '(unknown)') end),
    ('browser', case when e.kind = 'page' then coalesce(e.browser, '(unknown)') end),
    ('os', case when e.kind = 'page' then coalesce(e.os, '(unknown)') end),
    ('event', case when e.kind = 'event' then e.name end)
  ) as d(dimension, value)
  where d.value is not null
  group by e.site_id, e.day, d.dimension, d.value`;

const vitals = (rows: SQL) => sql`
  insert into daily_vital (site_id, day, metric, p75, samples)
  select e.site_id, e.day, e.name, percentile_cont(0.75) within group (order by e.value), count(*)
  from (${rows}) e
  where e.kind = 'vital' group by e.site_id, e.day, e.name`;

/**
 * A day an import wrote stays as imported: its figures can't be counted again from raw rows, and one
 * late event mustn't replace a whole day with itself. That event stays in the raw rows.
 */
async function withoutImportedDays(tx: Database, siteIds: readonly string[], day: string): Promise<string[]> {
  const imported = await rowsOf<{ site_id: string }>(tx, sql`select site_id from daily_site where site_id in (${siteList(siteIds)}) and day = ${day}::date and import_id is not null`);
  const held = new Set(imported.map(({ site_id }) => site_id));
  return siteIds.filter((id) => !held.has(id));
}

async function rebuildDay(tx: Database, allSiteIds: readonly string[], day: string): Promise<void> {
  const siteIds = await withoutImportedDays(tx, allSiteIds, day);
  if (siteIds.length === 0) return;
  const rows = dayRows(siteIds, day);
  for (const table of ["daily_site", "daily_dimension", "daily_vital"]) {
    await tx.execute(sql`delete from ${sql.identifier(table)} where site_id in (${siteList(siteIds)}) and day = ${day}::date`);
  }
  await tx.execute(siteTotals(rows));
  await tx.execute(dimensions(rows));
  await tx.execute(vitals(rows));
}

/**
 * Rebuilds these days from their raw rows, in the caller's transaction and workspace. Counted again
 * rather than added to: distinct visitors can't be added up, and doing the same work twice can't then
 * count anything twice. Only for days whose raw rows are still all there.
 */
export async function rebuildDays(tx: Database, days: readonly SiteDay[]): Promise<void> {
  const sitesPerDay = new Map<string, string[]>();
  for (const { siteId, day } of days) sitesPerDay.set(day, [...(sitesPerDay.get(day) ?? []), siteId]);
  for (const [day, siteIds] of sitesPerDay) await rebuildDay(tx, siteIds, day);
}
