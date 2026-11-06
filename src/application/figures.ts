import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { dailyDimension, dailySite, site } from "@/infrastructure/db/schema/analytics";
import { workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Period } from "./time-range";

export interface SiteFigures {
  id: string;
  name: string;
  lastWrittenAt: Date | null;
  days: { date: string; visitors: number; pageViews: number; events: number; bounces: number }[];
}

export interface Figures {
  /** Whose figures these are: what an app holding a key can name them by. */
  workspace: { id: string; name: string };
  from: string;
  to: string;
  timezone: "UTC";
  sites: SiteFigures[];
}

/** Per site and per day, in UTC, for a dashboard holding a key. Counts only: no pages, no people. */
export async function figuresOf(db: Database, workspaceId: string, period: Period, siteId?: string): Promise<Figures> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [named] = await tx.select({ id: workspace.id, name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
    const sites = await tx.select({ id: site.id, name: site.name, lastWrittenAt: site.lastWrittenAt }).from(site).where(siteId ? eq(site.id, siteId) : undefined).orderBy(asc(site.name));
    const rows = await tx.select().from(dailySite).where(and(gte(dailySite.day, period.from), lte(dailySite.day, period.to), siteId ? eq(dailySite.siteId, siteId) : undefined));
    const known = new Map(rows.map((row) => [`${row.siteId}\n${row.day}`, row]));
    return {
      workspace: named,
      from: period.from,
      to: period.to,
      timezone: "UTC",
      sites: sites.map((one) => ({
        ...one,
        days: period.days.map((date) => {
          const row = known.get(`${one.id}\n${date}`);
          return { date, visitors: row?.visitors ?? 0, pageViews: row?.pageViews ?? 0, events: row?.events ?? 0, bounces: row?.bounces ?? 0 };
        }),
      })),
    };
  });
}

/** What a day's figure can be asked of, by name: one page, or one custom event. */
export const BREAKDOWNS = ["page", "event"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];

export interface BreakdownFigures {
  site: { id: string; name: string };
  dimension: Breakdown;
  value: string;
  from: string;
  to: string;
  timezone: "UTC";
  /** `count` is the page's views, or the event's occurrences. Visitors are one per day. */
  days: { date: string; count: number; visitors: number }[];
}

/** One page's or one custom event's days: the caller names it, so this lists nothing. From rollups: they stay when raw rows go. Undefined for a site that isn't this workspace's. */
export async function breakdownOf(db: Database, workspaceId: string, { siteId, dimension, value, period }: { siteId: string; dimension: Breakdown; value: string; period: Period }): Promise<BreakdownFigures | undefined> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [found] = await tx.select({ id: site.id, name: site.name }).from(site).where(eq(site.id, siteId));
    if (!found) return undefined;
    const rows = await tx
      .select({ date: dailyDimension.day, count: dailyDimension.count, visitors: dailyDimension.visitors })
      .from(dailyDimension)
      .where(and(eq(dailyDimension.siteId, siteId), eq(dailyDimension.dimension, dimension), eq(dailyDimension.value, value), gte(dailyDimension.day, period.from), lte(dailyDimension.day, period.to)));
    const known = new Map(rows.map((row) => [row.date, row]));
    return { site: found, dimension, value, from: period.from, to: period.to, timezone: "UTC", days: period.days.map((date) => ({ date, count: known.get(date)?.count ?? 0, visitors: known.get(date)?.visitors ?? 0 })) };
  });
}
