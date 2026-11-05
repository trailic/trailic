import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { dailySite, site } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Period } from "./time-range";

export interface SiteFigures {
  id: string;
  name: string;
  lastWrittenAt: Date | null;
  days: { date: string; visitors: number; pageViews: number; events: number; bounces: number }[];
}

export interface Figures {
  from: string;
  to: string;
  timezone: "UTC";
  sites: SiteFigures[];
}

/** Per site and per day, in UTC, for a dashboard holding a key. Counts only: no pages, no people. */
export async function figuresOf(db: Database, workspaceId: string, period: Period, siteId?: string): Promise<Figures> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const sites = await tx.select({ id: site.id, name: site.name, lastWrittenAt: site.lastWrittenAt }).from(site).where(siteId ? eq(site.id, siteId) : undefined).orderBy(asc(site.name));
    const rows = await tx.select().from(dailySite).where(and(gte(dailySite.day, period.from), lte(dailySite.day, period.to), siteId ? eq(dailySite.siteId, siteId) : undefined));
    const known = new Map(rows.map((row) => [`${row.siteId}\n${row.day}`, row]));
    return {
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
