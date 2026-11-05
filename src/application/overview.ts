import { and, desc, eq, gte, lte, max, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { dailyDimension, dailySite, dailyVital, site, type Dimension } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Period } from "./time-range";

export interface DayTotals {
  date: string;
  visitors: number;
  pageViews: number;
  events: number;
  bounces: number;
}

export interface TopValue {
  value: string;
  count: number;
  visitors: number;
  /** Which site, when a page is listed across all of them: the same path on two sites is two pages. */
  siteName?: string;
}

export interface VitalFigure {
  metric: string;
  p75: number;
  samples: number;
}

export interface Overview {
  from: string;
  to: string;
  timezone: "UTC";
  /** When events last reached the database: everything here is at most that fresh. */
  lastWrittenAt: Date | null;
  totals: Omit<DayTotals, "date">;
  days: DayTotals[];
  pages: TopValue[];
  referrers: TopValue[];
  utm: Record<"source" | "medium" | "campaign" | "term" | "content", TopValue[]>;
  countries: TopValue[];
  devices: TopValue[];
  browsers: TopValue[];
  systems: TopValue[];
  vitals: VitalFigure[];
}

/** Which rollups a screen reads: one site, or all of a workspace's, whichever row-level security leaves. */
const onSite = (siteId: string | null, column: typeof dailySite.siteId | typeof dailyDimension.siteId | typeof dailyVital.siteId): SQL | undefined => (siteId ? eq(column, siteId) : undefined);

const inPeriod = (column: typeof dailySite.day | typeof dailyDimension.day | typeof dailyVital.day, { from, to }: Pick<Period, "from" | "to">) => and(gte(column, from), lte(column, to));

/** A day's totals laid out on every day of the period, so a quiet day shows as a zero rather than as nothing. */
function everyDay(rows: DayTotals[], days: readonly string[]): DayTotals[] {
  const known = new Map(rows.map((row) => [row.date, row]));
  return days.map((date) => known.get(date) ?? { date, visitors: 0, pageViews: 0, events: 0, bounces: 0 });
}

const sum = (rows: DayTotals[], field: keyof Omit<DayTotals, "date">) => rows.reduce((total, row) => total + row[field], 0);

async function dayTotals(tx: Database, siteId: string | null, period: Period): Promise<DayTotals[]> {
  const rows = await tx
    .select({ date: dailySite.day, visitors: sql<number>`sum(${dailySite.visitors})::int`, pageViews: sql<number>`sum(${dailySite.pageViews})::int`, events: sql<number>`sum(${dailySite.events})::int`, bounces: sql<number>`sum(${dailySite.bounces})::int` })
    .from(dailySite)
    .where(and(onSite(siteId, dailySite.siteId), inPeriod(dailySite.day, period)))
    .groupBy(dailySite.day);
  return everyDay(rows, period.days);
}

/** The biggest values of one dimension over a period. A value's visitors are added up over its days: a visitor is one per day. */
export async function topValues(tx: Database, siteId: string | null, dimension: Dimension, period: Pick<Period, "from" | "to">, limit = 10): Promise<TopValue[]> {
  const count = sql<number>`sum(${dailyDimension.count})::int`;
  return tx
    .select({ value: dailyDimension.value, count, visitors: sql<number>`sum(${dailyDimension.visitors})::int` })
    .from(dailyDimension)
    .where(and(onSite(siteId, dailyDimension.siteId), eq(dailyDimension.dimension, dimension), inPeriod(dailyDimension.day, period)))
    .groupBy(dailyDimension.value)
    .orderBy(desc(count), dailyDimension.value)
    .limit(limit);
}

/** Across every site, a path is only a page together with its site. */
async function topPagesAcrossSites(tx: Database, period: Pick<Period, "from" | "to">, limit: number): Promise<TopValue[]> {
  const count = sql<number>`sum(${dailyDimension.count})::int`;
  return tx
    .select({ value: dailyDimension.value, siteName: site.name, count, visitors: sql<number>`sum(${dailyDimension.visitors})::int` })
    .from(dailyDimension)
    .innerJoin(site, eq(site.id, dailyDimension.siteId))
    .where(and(eq(dailyDimension.dimension, "page"), inPeriod(dailyDimension.day, period)))
    .groupBy(dailyDimension.value, site.name)
    .orderBy(desc(count), dailyDimension.value)
    .limit(limit);
}

async function vitalsOf(tx: Database, siteId: string | null, period: Period): Promise<VitalFigure[]> {
  return tx
    .select({ metric: dailyVital.metric, p75: sql<number>`(sum(${dailyVital.p75} * ${dailyVital.samples}) / sum(${dailyVital.samples}))::real`, samples: sql<number>`sum(${dailyVital.samples})::int` })
    .from(dailyVital)
    .where(and(onSite(siteId, dailyVital.siteId), inPeriod(dailyVital.day, period)))
    .groupBy(dailyVital.metric)
    .orderBy(dailyVital.metric);
}

export async function lastWrittenAt(tx: Database, siteId: string | null): Promise<Date | null> {
  const [row] = await tx.select({ at: max(site.lastWrittenAt) }).from(site).where(siteId ? eq(site.id, siteId) : undefined);
  return row?.at ?? null;
}

/** What replaces a hosted dashboard, for one site or a whole workspace. Reads rollups only, so a 90-day chart costs the same with or without its raw rows. */
export async function overviewOf(db: Database, workspaceId: string, siteId: string | null, period: Period): Promise<Overview> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const days = await dayTotals(tx, siteId, period);
    const top = (dimension: Dimension) => topValues(tx, siteId, dimension, period);
    return {
      from: period.from,
      to: period.to,
      timezone: "UTC",
      lastWrittenAt: await lastWrittenAt(tx, siteId),
      totals: { visitors: sum(days, "visitors"), pageViews: sum(days, "pageViews"), events: sum(days, "events"), bounces: sum(days, "bounces") },
      days,
      pages: siteId ? await top("page") : await topPagesAcrossSites(tx, period, 10),
      referrers: await top("referrer"),
      utm: { source: await top("utm_source"), medium: await top("utm_medium"), campaign: await top("utm_campaign"), term: await top("utm_term"), content: await top("utm_content") },
      countries: await top("country"),
      devices: await top("device"),
      browsers: await top("browser"),
      systems: await top("os"),
      vitals: await vitalsOf(tx, siteId, period),
    };
  });
}
