import { and, asc, desc, eq, gte, isNull, lte, min, sql } from "drizzle-orm";
import { dayOf } from "@/domain/collected";
import { cleanedDay, type CleanedDay, type ImportedDay } from "@/domain/history";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { sha256 } from "@/infrastructure/crypto/secrets";
import type { Database } from "@/infrastructure/db/client";
import { dailyDimension, dailySite, historyImport, site } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { roleIn } from "./team";
import type { Period } from "./time-range";

const ROWS_AT_ONCE = 1_000;
const LONGEST_LABEL = 300;

export interface HistoryInput {
  siteId: string;
  /** Where these figures were counted. Importing again from the same source replaces what it wrote. */
  source: string;
  /** What they count, in words a member reads beside them. */
  counts: string;
  note?: string | null;
  days: readonly ImportedDay[];
}

export interface HistoryReport {
  status: "written" | "unchanged" | "would-write" | "no-such-site";
  daysWritten: number;
  /** Today, or on or after the day this site started collecting: those days are the collector's. */
  daysHeldBack: number;
  pageViews: number;
  events: number;
  rows: number;
}

const NOTHING_WRITTEN = { daysWritten: 0, daysHeldBack: 0, pageViews: 0, events: 0, rows: 0 };

/** The workspace a site belongs to. Trusted path, for whoever runs the instance and can read every workspace anyway. */
export async function workspaceOfSite(db: Database, siteId: string): Promise<string | undefined> {
  const [found] = await db.select({ workspaceId: site.workspaceId }).from(site).where(eq(site.id, siteId));
  return found?.workspaceId;
}

async function firstCollectedDay(tx: Database, siteId: string): Promise<string | null> {
  const [row] = await tx.select({ day: min(dailySite.day) }).from(dailySite).where(and(eq(dailySite.siteId, siteId), isNull(dailySite.importId)));
  return row?.day ?? null;
}

/** The days an import may have: whole ones, before any this site collected. So however often it runs, a day has one source. */
function daysItMayHave(days: readonly ImportedDay[], anonymous: boolean, today: string, firstCollected: string | null): { kept: CleanedDay[]; heldBack: number } {
  const kept: CleanedDay[] = [];
  let heldBack = 0;
  for (const day of [...days].sort((a, b) => (a.day < b.day ? -1 : 1))) {
    if (day.day >= today || (firstCollected && day.day >= firstCollected)) {
      heldBack += 1;
      continue;
    }
    const cleaned = cleanedDay(day, anonymous);
    if (cleaned) kept.push(cleaned);
  }
  return { kept, heldBack };
}

function inChunks<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += ROWS_AT_ONCE) chunks.push(items.slice(start, start + ROWS_AT_ONCE));
  return chunks;
}

/** Writes each day's totals and then its rows. A day the collector reached first, in a flush running right now, is left to it. */
async function writeDays(tx: Database, importId: string, siteId: string, days: readonly CleanedDay[]): Promise<{ written: CleanedDay[]; rows: number }> {
  const held = new Set<string>();
  for (const chunk of inChunks(days)) {
    const inserted = await tx
      .insert(dailySite)
      .values(chunk.map(({ day, visitors, pageViews, events, bounces }) => ({ siteId, day, visitors, pageViews, events, bounces, importId })))
      .onConflictDoNothing()
      .returning({ day: dailySite.day });
    for (const { day } of inserted) held.add(day);
  }
  const written = days.filter(({ day }) => held.has(day));
  const rows = written.flatMap(({ day, rows: dayRows }) => dayRows.map((row) => ({ siteId, day, importId, ...row })));
  for (const chunk of inChunks(rows)) await tx.insert(dailyDimension).values(chunk);
  return { written, rows: rows.length };
}

async function removeRows(tx: Database, siteId: string, importId: string): Promise<void> {
  await tx.delete(dailyDimension).where(and(eq(dailyDimension.siteId, siteId), eq(dailyDimension.importId, importId)));
  await tx.delete(dailySite).where(and(eq(dailySite.siteId, siteId), eq(dailySite.importId, importId)));
}

const sumOf = (days: readonly CleanedDay[], field: "pageViews" | "events") => days.reduce((total, day) => total + day[field], 0);

const checksumOf = (input: HistoryInput, days: readonly CleanedDay[]) => sha256(JSON.stringify({ counts: input.counts, note: input.note ?? null, days }));

async function recordImport(tx: Database, input: HistoryInput, importId: string, checksum: string, now: Date, written: readonly CleanedDay[]): Promise<void> {
  const figures = { counts: input.counts.slice(0, LONGEST_LABEL), note: input.note?.slice(0, LONGEST_LABEL) ?? null, firstDay: written[0].day, lastDay: written[written.length - 1].day, days: written.length, pageViews: sumOf(written, "pageViews"), events: sumOf(written, "events"), checksum, importedAt: now };
  await tx
    .insert(historyImport)
    .values({ id: importId, siteId: input.siteId, source: input.source.slice(0, LONGEST_LABEL), ...figures })
    .onConflictDoUpdate({ target: [historyImport.siteId, historyImport.source], set: figures });
}

/**
 * One site's history from another tool, in one transaction, as the restricted role: all of it or
 * none of it, and only in this workspace. Doing it again with the same figures writes nothing; with
 * other figures, it replaces only what this source wrote, so it can't count anything twice.
 */
export async function importHistory(db: Database, workspaceId: string, input: HistoryInput, now: Date, { dryRun = false } = {}): Promise<HistoryReport> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [found] = await tx.select({ anonymous: site.anonymous }).from(site).where(eq(site.id, input.siteId));
    if (!found) return { status: "no-such-site", ...NOTHING_WRITTEN };
    const { kept, heldBack } = daysItMayHave(input.days, found.anonymous, dayOf(now), await firstCollectedDay(tx, input.siteId));
    const summary = { daysHeldBack: heldBack, pageViews: sumOf(kept, "pageViews"), events: sumOf(kept, "events"), rows: kept.reduce((total, { rows }) => total + rows.length, 0) };
    const [existing] = await tx.select({ id: historyImport.id, checksum: historyImport.checksum }).from(historyImport).where(and(eq(historyImport.siteId, input.siteId), eq(historyImport.source, input.source.slice(0, LONGEST_LABEL))));
    const checksum = checksumOf(input, kept);
    if (existing?.checksum === checksum) return { status: "unchanged", ...summary, daysWritten: 0 };
    if (kept.length === 0 && !existing) return { status: "unchanged", ...summary, daysWritten: 0 };
    if (dryRun) return { status: "would-write", ...summary, daysWritten: kept.length };
    const importId = existing?.id ?? crypto.randomUUID();
    if (existing) await removeRows(tx, input.siteId, importId);
    const { written, rows } = await writeDays(tx, importId, input.siteId, kept);
    if (written.length === 0) {
      await tx.delete(historyImport).where(eq(historyImport.id, importId));
      return { status: "written", ...NOTHING_WRITTEN, daysHeldBack: heldBack + kept.length };
    }
    await recordImport(tx, input, importId, checksum, now, written);
    return { status: "written", daysWritten: written.length, daysHeldBack: heldBack + kept.length - written.length, pageViews: sumOf(written, "pageViews"), events: sumOf(written, "events"), rows };
  });
}

export interface ImportedHistory {
  source: string;
  counts: string;
  note: string | null;
  firstDay: string;
  lastDay: string;
  /** How many of what's being read it covers: one, for a site's own page. */
  sites: number;
}

/** Which imported figures a reading over this period holds, so whoever reads it can be told. In the caller's transaction and workspace. */
export async function importedHistoryIn(tx: Database, siteId: string | null, { from, to }: Pick<Period, "from" | "to">): Promise<ImportedHistory[]> {
  return tx
    .select({ source: historyImport.source, counts: historyImport.counts, note: historyImport.note, firstDay: sql<string>`min(${historyImport.firstDay})`, lastDay: sql<string>`max(${historyImport.lastDay})`, sites: sql<number>`count(*)::int` })
    .from(historyImport)
    .where(and(siteId ? eq(historyImport.siteId, siteId) : undefined, lte(historyImport.firstDay, to), gte(historyImport.lastDay, from)))
    .groupBy(historyImport.source, historyImport.counts, historyImport.note)
    .orderBy(asc(historyImport.source));
}

export type HistoryImportRow = typeof historyImport.$inferSelect;

export const historyImportsOf = (db: Database, workspaceId: string, siteId: string): Promise<HistoryImportRow[]> => withWorkspace(db, workspaceId, (tx) => tx.select().from(historyImport).where(eq(historyImport.siteId, siteId)).orderBy(desc(historyImport.importedAt)));

/**
 * Takes an import's figures back out, for whoever manages the workspace's settings. Anything collected
 * on those days stays in the raw rows, and reaches the rollups when a flush next touches its day.
 */
export async function removeHistoryImport(db: Database, workspaceId: string, userId: string, siteId: string, importId: string): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  return withWorkspace(db, workspaceId, async (tx) => {
    const removed = await tx.delete(historyImport).where(and(eq(historyImport.siteId, siteId), eq(historyImport.id, importId))).returning({ id: historyImport.id });
    if (removed.length === 0) return { ok: false, error: "There’s no such import on this site." };
    await removeRows(tx, siteId, importId);
    return { ok: true, said: "Imported figures removed." };
  });
}
