import { beforeAll, describe, expect, it } from "vitest";
import { customEventsOf } from "@/application/custom-events";
import { breakdownOf, figuresOf } from "@/application/figures";
import { flushBuffer } from "@/application/flush";
import { historyImportsOf, importHistory, removeHistoryImport, workspaceOfSite, type HistoryInput } from "@/application/history";
import { overviewOf } from "@/application/overview";
import { periodEndingAt } from "@/application/time-range";
import { cleanedDay, HistoryFileError, IMPORTED_DAY, sitesInFile, type ImportedDay } from "@/domain/history";
import type { Database } from "@/infrastructure/db/client";
import { dailyDimension, dailySite, event } from "@/infrastructure/db/schema/analytics";
import { member } from "@/infrastructure/db/schema/tenancy";
import { user } from "@/infrastructure/db/schema/auth";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { addSite, batchOf, collected, memoryBuffer, NOW, visitor } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

const OTHER_TOOL = "Another tool";

/** 2 visitors, 3 page views, 1 event, 1 bounce, worked out by hand. */
const dayOfFigures = (day: string, overrides: Partial<ImportedDay> = {}): ImportedDay => ({
  day,
  visitors: 2,
  pageViews: 3,
  events: 1,
  bounces: 1,
  dimensions: {
    page: [
      { value: "/", count: 2, visitors: 2 },
      { value: "/pricing", count: 1, visitors: 1 },
    ],
    referrer: [{ value: "(direct)", count: 3, visitors: 2 }],
    country: [{ value: "FR", count: 3, visitors: 2 }],
    event: [{ value: "signup", count: 1, visitors: 1 }],
  },
  ...overrides,
});

async function seat(name = "Acme") {
  const { workspaceId, userId } = await createTestWorkspace(db, name);
  const site = await addSite(db, workspaceId, userId, name);
  return { workspaceId, userId, site };
}

const history = (siteId: string, days: ImportedDay[], overrides: Partial<HistoryInput> = {}): HistoryInput => ({ siteId, source: OTHER_TOOL, counts: "all page views it recorded", days, ...overrides });

const siteDays = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(dailySite).orderBy(dailySite.day));
const dimensionRows = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(dailyDimension));

async function flushed(site: { id: string; key: string }, events: ReturnType<typeof collected>[]) {
  const buffer = memoryBuffer();
  await buffer.append(batchOf(site, events));
  await flushBuffer({ db, buffer, now: () => NOW });
}

const PERIOD = periodEndingAt(NOW, 7);

describe("importing a site's history", () => {
  it("writes its days into the rollups, marked with the import", async () => {
    const { workspaceId, site } = await seat();
    const report = await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-01"), dayOfFigures("2026-11-02")]), NOW);
    expect(report).toMatchObject({ status: "written", daysWritten: 2, daysHeldBack: 0, pageViews: 6, events: 2, rows: 10 });
    const days = await siteDays(workspaceId);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ day: "2026-11-01", visitors: 2, pageViews: 3, events: 1, bounces: 1 });
    const [imported] = await historyImportsOf(db, workspaceId, site.id);
    expect(imported).toMatchObject({ source: OTHER_TOOL, firstDay: "2026-11-01", lastDay: "2026-11-02", days: 2, pageViews: 6, events: 2 });
    for (const day of days) expect(day.importId).toBe(imported.id);
    for (const row of await dimensionRows(workspaceId)) expect(row.importId).toBe(imported.id);
  });

  it("writes nothing when imported again unchanged", async () => {
    const { workspaceId, site } = await seat();
    const input = history(site.id, [dayOfFigures("2026-11-01")]);
    await importHistory(db, workspaceId, input, NOW);
    const [before] = await historyImportsOf(db, workspaceId, site.id);
    const again = await importHistory(db, workspaceId, input, new Date(NOW.getTime() + 60_000));
    expect(again).toMatchObject({ status: "unchanged", daysWritten: 0 });
    const [after] = await historyImportsOf(db, workspaceId, site.id);
    expect(after.importedAt).toEqual(before.importedAt);
    expect((await siteDays(workspaceId))[0].pageViews).toBe(3);
  });

  it("replaces only its own rows when imported again differently, and can't count anything twice", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-01"), dayOfFigures("2026-11-02")]), NOW);
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-02", { pageViews: 5 })]), NOW);
    const days = await siteDays(workspaceId);
    expect(days.map(({ day, pageViews }) => [day, pageViews])).toEqual([["2026-11-02", 5]]);
    expect(await historyImportsOf(db, workspaceId, site.id)).toHaveLength(1);
  });

  it("leaves another source's days to it", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-01")]), NOW);
    const second = await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-01", { pageViews: 9 }), dayOfFigures("2026-11-02")], { source: "A third tool" }), NOW);
    expect(second).toMatchObject({ status: "written", daysWritten: 1, daysHeldBack: 1 });
    expect((await siteDays(workspaceId)).map(({ pageViews }) => pageViews)).toEqual([3, 3]);
  });

  it("refuses a site of another workspace", async () => {
    const { workspaceId } = await seat();
    const other = await seat("Elsewhere");
    expect(await importHistory(db, workspaceId, history(other.site.id, [dayOfFigures("2026-11-01")]), NOW)).toMatchObject({ status: "no-such-site" });
    expect(await siteDays(other.workspaceId)).toHaveLength(0);
  });

  it("says what a dry run would write, and writes nothing", async () => {
    const { workspaceId, site } = await seat();
    expect(await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-01")]), NOW, { dryRun: true })).toMatchObject({ status: "would-write", daysWritten: 1, pageViews: 3, rows: 5 });
    expect(await siteDays(workspaceId)).toHaveLength(0);
    expect(await historyImportsOf(db, workspaceId, site.id)).toHaveLength(0);
  });

  it("finds a site's workspace, and nothing for a site that isn't there", async () => {
    const { workspaceId, site } = await seat();
    expect(await workspaceOfSite(db, site.id)).toBe(workspaceId);
    expect(await workspaceOfSite(db, crypto.randomUUID())).toBeUndefined();
  });
});

describe("a day has one source", () => {
  it("never writes today, or a day on or after the first one collected, and keeps what was collected", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [collected({ at: "2026-11-03T10:00:00.000Z", visitor: visitor(1), path: "/collected" })]);
    const report = await importHistory(db, workspaceId, history(site.id, ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map((day) => dayOfFigures(day))), NOW);
    expect(report).toMatchObject({ status: "written", daysWritten: 1, daysHeldBack: 3 });
    const days = await siteDays(workspaceId);
    expect(days.map(({ day, pageViews, importId }) => [day, pageViews, importId !== null])).toEqual([
      ["2026-11-02", 3, true],
      ["2026-11-03", 1, false],
    ]);
  });

  it("keeps an imported day whole when a late event lands on it, and keeps the event in the raw rows", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-02")]), NOW);
    await flushed(site, [collected({ at: "2026-11-02T23:59:00.000Z", visitor: visitor(1), path: "/late" })]);
    const [day] = await siteDays(workspaceId);
    expect(day).toMatchObject({ day: "2026-11-02", pageViews: 3, visitors: 2 });
    expect(day.importId).not.toBeNull();
    const rows = await dimensionRows(workspaceId);
    expect(rows.some(({ value }) => value === "/late")).toBe(false);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(event))).toHaveLength(1);
  });

  it("still rebuilds the days around it", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-01")]), NOW);
    await flushed(site, [collected({ at: "2026-11-04T10:00:00.000Z", visitor: visitor(1) })]);
    expect((await siteDays(workspaceId)).map(({ day, importId }) => [day, importId !== null])).toEqual([
      ["2026-11-01", true],
      ["2026-11-04", false],
    ]);
  });
});

describe("reading imported figures", () => {
  it("adds them to the overview, marks their days and says what they count", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-02")], { note: "It holds nothing for 1 November." }), NOW);
    await flushed(site, [collected({ at: "2026-11-04T10:00:00.000Z", visitor: visitor(1), path: "/" })]);
    const overview = await overviewOf(db, workspaceId, site.id, PERIOD);
    expect(overview.totals).toMatchObject({ visitors: 3, pageViews: 4, events: 1, bounces: 2 });
    const marks = Object.fromEntries(overview.days.map(({ date, imported }) => [date, imported]));
    expect(marks["2026-11-02"]).toBe(true);
    expect(marks["2026-11-04"]).toBe(false);
    expect(marks["2026-11-03"]).toBe(false);
    expect(overview.imported).toEqual([{ source: OTHER_TOOL, counts: "all page views it recorded", note: "It holds nothing for 1 November.", firstDay: "2026-11-02", lastDay: "2026-11-02", sites: 1 }]);
    expect(overview.pages.find(({ value }) => value === "/")).toMatchObject({ count: 3, visitors: 3 });
  });

  it("doesn't mention an import outside the period", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-10-01")]), NOW);
    const overview = await overviewOf(db, workspaceId, site.id, PERIOD);
    expect(overview.imported).toEqual([]);
    expect(overview.totals.pageViews).toBe(0);
  });

  it("across a workspace, says on how many sites", async () => {
    const { workspaceId, userId, site } = await seat();
    const second = await addSite(db, workspaceId, userId, "Second", "second.example");
    for (const id of [site.id, second.id]) await importHistory(db, workspaceId, history(id, [dayOfFigures("2026-11-02")]), NOW);
    const overview = await overviewOf(db, workspaceId, null, PERIOD);
    expect(overview.imported).toMatchObject([{ source: OTHER_TOOL, sites: 2 }]);
    expect(overview.totals.pageViews).toBe(6);
  });

  it("marks them in figures and breakdowns for whoever holds a key", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-02")]), NOW);
    const figures = await figuresOf(db, workspaceId, PERIOD, site.id);
    expect(figures.sites[0].days.find(({ date }) => date === "2026-11-02")).toMatchObject({ pageViews: 3, imported: true });
    expect(figures.sites[0].days.find(({ date }) => date === "2026-11-03")).toMatchObject({ pageViews: 0, imported: false });
    const page = await breakdownOf(db, workspaceId, { siteId: site.id, dimension: "page", value: "/", period: PERIOD });
    expect(page?.days.find(({ date }) => date === "2026-11-02")).toMatchObject({ count: 2, imported: true });
  });

  it("names them with custom events", async () => {
    const { workspaceId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-02")]), NOW);
    const report = await customEventsOf(db, workspaceId, site.id, PERIOD);
    expect(report.events[0]).toMatchObject({ name: "signup", count: 1 });
    expect(report.imported).toMatchObject([{ source: OTHER_TOOL }]);
  });
});

describe("removing an import", () => {
  it("takes its figures out, leaves collected ones, and is for those who manage settings", async () => {
    const { workspaceId, userId, site } = await seat();
    await importHistory(db, workspaceId, history(site.id, [dayOfFigures("2026-11-02")]), NOW);
    await flushed(site, [collected({ at: "2026-11-04T10:00:00.000Z", visitor: visitor(1) })]);
    const [imported] = await historyImportsOf(db, workspaceId, site.id);

    const viewerId = crypto.randomUUID();
    await db.insert(user).values({ id: viewerId, name: "Viewer", email: `${viewerId}@example.test` });
    await db.insert(member).values({ workspaceId, userId: viewerId, role: "member" });
    expect(await removeHistoryImport(db, workspaceId, viewerId, site.id, imported.id)).toMatchObject({ ok: false });
    expect(await siteDays(workspaceId)).toHaveLength(2);

    expect(await removeHistoryImport(db, workspaceId, userId, site.id, imported.id)).toMatchObject({ ok: true });
    expect((await siteDays(workspaceId)).map(({ day }) => day)).toEqual(["2026-11-04"]);
    expect(await historyImportsOf(db, workspaceId, site.id)).toHaveLength(0);
    expect(await removeHistoryImport(db, workspaceId, userId, site.id, imported.id)).toMatchObject({ ok: false });
  });
});

describe("what's kept of a day", () => {
  const withPages = (page: { value: string; count: number; visitors: number }[], overrides: Partial<ImportedDay> = {}): ImportedDay => ({ day: "2026-11-01", visitors: 5, pageViews: 10, events: 0, bounces: 2, dimensions: { page }, ...overrides });

  it("cleans a path the way the collector does", () => {
    const cleaned = cleanedDay(withPages([{ value: "/reset/ada%40acme.example?token=x#top", count: 4, visitors: 2 }, { value: "/a/4f9d2c7e1b8a6d3f0e5c9b2a", count: 3, visitors: 2 }, { value: "/a/9e1d7c3b5f2a8d4c6b0e7f1a", count: 3, visitors: 2 }]), false);
    expect(cleaned?.rows).toEqual([
      { dimension: "page", value: "/a/[token]", count: 6, visitors: 4 },
      { dimension: "page", value: "/reset/[email]", count: 4, visitors: 2 },
    ]);
  });

  it("takes personal areas off the totals in anonymous mode, and only then", () => {
    const pages = [{ value: "/account/settings", count: 4, visitors: 3 }, { value: "/fr/u/ada", count: 1, visitors: 1 }, { value: "/universities", count: 5, visitors: 2 }];
    const anonymous = cleanedDay(withPages(pages), true);
    expect(anonymous).toMatchObject({ pageViews: 5, visitors: 5, bounces: 2 });
    expect(anonymous?.rows.map(({ value }) => value)).toEqual(["/universities"]);
    expect(cleanedDay(withPages(pages), false)).toMatchObject({ pageViews: 10 });
  });

  it("keeps no campaign tags in anonymous mode, and keeps them otherwise", () => {
    const tagged = { ...withPages([]), dimensions: { utm_source: [{ value: "news", count: 3, visitors: 2 }] } };
    expect(cleanedDay(tagged, true)?.rows).toEqual([]);
    expect(cleanedDay(tagged, false)?.rows).toEqual([{ dimension: "utm_source", value: "news", count: 3, visitors: 2 }]);
  });

  it("keeps a referrer's host only, and values within reason", () => {
    const day = { ...withPages([]), dimensions: { referrer: [{ value: "https://News.example/a?b=c", count: 1, visitors: 1 }, { value: "(direct)", count: 1, visitors: 1 }, { value: "not a host", count: 1, visitors: 1 }], country: [{ value: "France", count: 1, visitors: 1 }, { value: "FR", count: 1, visitors: 1 }], device: [{ value: "fridge", count: 1, visitors: 1 }], event: [{ value: "x".repeat(99), count: 1, visitors: 1 }] } };
    const rows = cleanedDay(day, true)?.rows ?? [];
    expect(rows.filter(({ dimension }) => dimension === "referrer").map(({ value }) => value)).toEqual(["(direct)", "news.example"]);
    expect(rows.filter(({ dimension }) => dimension === "country").map(({ value }) => value)).toEqual(["(unknown)", "FR"]);
    expect(rows.find(({ dimension }) => dimension === "device")?.value).toBe("(unknown)");
    expect(rows.find(({ dimension }) => dimension === "event")?.value).toHaveLength(64);
  });

  it("drops a path that isn't one", () => {
    expect(cleanedDay(withPages([{ value: "https://acme.example/", count: 1, visitors: 1 }]), false)).toMatchObject({ pageViews: 9 });
  });

  it("leaves nothing of a day with nothing left", () => {
    expect(cleanedDay(withPages([{ value: "/admin", count: 10, visitors: 5 }]), true)).toBeNull();
  });
});

describe("a history file", () => {
  const SITE_A = "00000000-0000-4000-8000-00000000000a";
  const SITE_B = "00000000-0000-4000-8000-00000000000b";
  const line = (site: string, day: string) => JSON.stringify({ site, day, visitors: 1, pageViews: 1, events: 0, bounces: 1 });

  async function* linesOf(lines: string[]) {
    yield* lines;
  }

  const read = async (lines: string[]) => {
    const sites: { siteId: string; days: number }[] = [];
    for await (const { siteId, days } of sitesInFile(linesOf(lines))) sites.push({ siteId, days: days.length });
    return sites;
  };

  it("gives its sites one at a time, and skips empty lines", async () => {
    expect(await read([line(SITE_A, "2026-11-01"), "", line(SITE_A, "2026-11-02"), line(SITE_B, "2026-11-01")])).toEqual([
      { siteId: SITE_A, days: 2 },
      { siteId: SITE_B, days: 1 },
    ]);
  });

  it("refuses a site found again later, since it would replace what was just written", async () => {
    await expect(read([line(SITE_A, "2026-11-01"), line(SITE_B, "2026-11-01"), line(SITE_A, "2026-11-02")])).rejects.toThrow(HistoryFileError);
  });

  it("refuses a bad line and says only where it is", async () => {
    await expect(read(["{ not json: ada@acme.example"])).rejects.toThrow("Line 1 isn’t a day of figures.");
    await expect(read([JSON.stringify({ site: SITE_A, day: "yesterday", visitors: 1, pageViews: 1, events: 0, bounces: 0 })])).rejects.toThrow("Line 1");
  });

  it("refuses figures that can't be", () => {
    expect(IMPORTED_DAY.safeParse({ day: "2026-11-01", visitors: 3, pageViews: 1, events: 0, bounces: 0 }).success).toBe(false);
    expect(IMPORTED_DAY.safeParse({ day: "2026-11-01", visitors: 1, pageViews: 1, events: 0, bounces: 2 }).success).toBe(false);
    expect(IMPORTED_DAY.safeParse({ day: "2026-11-01", visitors: 1, pageViews: 1, events: 0, bounces: 0, dimensions: { colour: [] } }).success).toBe(false);
  });
});
