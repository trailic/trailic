import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "@/infrastructure/db/client";
import { dailyDimension } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { importedHistoryIn, type ImportedHistory } from "./history";
import { lastWrittenAt } from "./overview";
import type { Period } from "./time-range";

export interface CustomEvent {
  name: string;
  count: number;
  /** Added up over days: a visitor is one per day. */
  visitors: number;
  days: { date: string; count: number }[];
}

export interface CustomEventsReport {
  from: string;
  to: string;
  timezone: "UTC";
  lastWrittenAt: Date | null;
  events: CustomEvent[];
  imported: ImportedHistory[];
}

const MOST_EVENTS = 100;

/** Custom events over a period, the most frequent first, each with its days. From rollups: they stay when raw rows go. */
export async function customEventsOf(db: Database, workspaceId: string, siteId: string | null, period: Period): Promise<CustomEventsReport> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .select({ name: dailyDimension.value, date: dailyDimension.day, count: sql<number>`sum(${dailyDimension.count})::int`, visitors: sql<number>`sum(${dailyDimension.visitors})::int` })
      .from(dailyDimension)
      .where(and(eq(dailyDimension.dimension, "event"), gte(dailyDimension.day, period.from), lte(dailyDimension.day, period.to), siteId ? eq(dailyDimension.siteId, siteId) : undefined))
      .groupBy(dailyDimension.value, dailyDimension.day)
      .orderBy(desc(sql`sum(${dailyDimension.count})`));
    const named = new Map<string, CustomEvent>();
    for (const { name, date, count, visitors } of rows) {
      const entry = named.get(name) ?? { name, count: 0, visitors: 0, days: [] };
      entry.count += count;
      entry.visitors += visitors;
      entry.days.push({ date, count });
      named.set(name, entry);
    }
    const events = [...named.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, MOST_EVENTS);
    for (const entry of events) {
      const known = new Map(entry.days.map(({ date, count }) => [date, count]));
      entry.days = period.days.map((date) => ({ date, count: known.get(date) ?? 0 }));
    }
    return { from: period.from, to: period.to, timezone: "UTC", lastWrittenAt: await lastWrittenAt(tx, siteId), events, imported: await importedHistoryIn(tx, siteId, period) };
  });
}
