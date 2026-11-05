import { beforeAll, describe, expect, it } from "vitest";
import { customEventsOf } from "@/application/custom-events";
import { figuresOf } from "@/application/figures";
import { flushBuffer } from "@/application/flush";
import { overviewOf, topValues } from "@/application/overview";
import { periodEndingAt } from "@/application/time-range";
import type { Database } from "@/infrastructure/db/client";
import { dailyDimension, dailySite, dailyVital } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { addSite, batchOf, collected, memoryBuffer, NOW, visitor } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

const DAY = "2026-11-03";
const at = (time: string, day = DAY) => `${day}T${time}:00.000Z`;

/**
 * One day on one site, worked out by hand:
 *   visitor 1: / then /pricing, from nowhere, on a phone in France        → 2 pages
 *   visitor 2: /, from news.example, tagged utm_source=news, in Germany    → 1 page: a bounce
 *   user_1:    /pricing and an event signup, on a phone in France          → 1 page: a bounce
 *   visitor 4: only an event click, no page                                → not a visitor
 * So: 3 visitors, 4 page views, 2 events, 2 bounces.
 */
const THE_DAY = [
  collected({ visitor: visitor(1), path: "/", at: at("08:00"), country: "FR", device: "mobile", browser: "Safari", os: "iOS" }),
  collected({ visitor: visitor(1), path: "/pricing", at: at("08:01"), country: "FR", device: "mobile", browser: "Safari", os: "iOS" }),
  collected({ visitor: visitor(2), path: "/", at: at("09:00"), country: "DE", device: "desktop", browser: "Firefox", os: "Linux", referrer: "news.example", utmSource: "news", utmMedium: "mail", utmCampaign: "autumn" }),
  collected({ visitor: visitor(3), userId: "user_1", path: "/pricing", at: at("10:00"), country: "FR", device: "mobile", browser: "Safari", os: "iOS" }),
  collected({ kind: "event", visitor: visitor(3), userId: "user_1", name: "signup", path: "/pricing", at: at("10:01"), country: "FR" }),
  collected({ kind: "event", visitor: visitor(4), name: "click", path: "/", at: at("11:00") }),
];

async function seat(name = "Acme") {
  const { workspaceId, userId } = await createTestWorkspace(db, name);
  const site = await addSite(db, workspaceId, userId, name);
  return { workspaceId, userId, site };
}

async function flushed(site: { id: string; key: string }, ...batches: ReturnType<typeof collected>[][]) {
  const buffer = memoryBuffer();
  for (const events of batches) await buffer.append(batchOf(site, events));
  await flushBuffer({ db, buffer, now: () => NOW });
}

const PERIOD = periodEndingAt(NOW, 7);

describe("a day's rollup", () => {
  it("adds up to what happened", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, THE_DAY);
    const [totals] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(dailySite));
    expect(totals).toMatchObject({ day: DAY, visitors: 3, pageViews: 4, events: 2, bounces: 2 });
  });

  it("counts every dimension by hand-worked numbers", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, THE_DAY);
    const rows = await withWorkspace(db, workspaceId, (tx) => tx.select().from(dailyDimension));
    const of = (dimension: string) =>
      Object.fromEntries(
        rows
          .filter((row) => row.dimension === dimension)
          .map(({ value, count, visitors }) => [value, [count, visitors]]),
      );
    expect(of("page")).toEqual({ "/": [2, 2], "/pricing": [2, 2] });
    expect(of("referrer")).toEqual({ "(direct)": [3, 2], "news.example": [1, 1] });
    expect(of("utm_source")).toEqual({ news: [1, 1] });
    expect(of("utm_medium")).toEqual({ mail: [1, 1] });
    expect(of("utm_campaign")).toEqual({ autumn: [1, 1] });
    expect(of("utm_term")).toEqual({});
    expect(of("country")).toEqual({ FR: [3, 2], DE: [1, 1] });
    expect(of("device")).toEqual({ mobile: [3, 2], desktop: [1, 1] });
    expect(of("browser")).toEqual({ Safari: [3, 2], Firefox: [1, 1] });
    expect(of("os")).toEqual({ iOS: [3, 2], Linux: [1, 1] });
    expect(of("event")).toEqual({ signup: [1, 1], click: [1, 1] });
  });

  it("is the same in batches as in one go: visitors are counted again, not added", async () => {
    const whole = await seat("Whole");
    const pieces = await seat("Pieces");
    await flushed(whole.site, THE_DAY);
    for (const event of THE_DAY) await flushed(pieces.site, [event]);
    const totalsOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select({ visitors: dailySite.visitors, pageViews: dailySite.pageViews, events: dailySite.events, bounces: dailySite.bounces }).from(dailySite));
    expect(await totalsOf(pieces.workspaceId)).toEqual(await totalsOf(whole.workspaceId));
  });

  it("keeps two days apart at midnight, UTC", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [collected({ at: "2026-11-02T23:59:59.000Z" }), collected({ at: "2026-11-03T00:00:00.000Z" })]);
    const rows = await withWorkspace(db, workspaceId, (tx) => tx.select({ day: dailySite.day, pageViews: dailySite.pageViews }).from(dailySite));
    expect(rows.sort((a, b) => a.day.localeCompare(b.day))).toEqual([
      { day: "2026-11-02", pageViews: 1 },
      { day: "2026-11-03", pageViews: 1 },
    ]);
  });

  it("leaves other days and other sites alone", async () => {
    const { workspaceId, userId, site } = await seat();
    const other = await addSite(db, workspaceId, userId, "Other", "other.example");
    await flushed(site, [collected({ at: at("08:00", "2026-11-02") })]);
    await flushed(other, [collected({ at: at("08:00") }), collected({ at: at("08:00") })]);
    await flushed(site, [collected({ at: at("09:00") })]);
    const rows = await withWorkspace(db, workspaceId, (tx) => tx.select().from(dailySite));
    const pageViews = (siteId: string, day: string) => rows.find((row) => row.siteId === siteId && row.day === day)?.pageViews;
    expect(pageViews(site.id, "2026-11-02")).toBe(1);
    expect(pageViews(site.id, DAY)).toBe(1);
    expect(pageViews(other.id, DAY)).toBe(2);
  });

  it("works out the 75th percentile of a day's web vitals", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [100, 200, 300, 400, 500].map((value) => collected({ kind: "vital", name: "LCP", value, at: at("08:00") })));
    const rows = await withWorkspace(db, workspaceId, (tx) => tx.select().from(dailyVital));
    expect(rows).toMatchObject([{ metric: "LCP", p75: 400, samples: 5 }]);
  });
});

describe("the overview", () => {
  it("lays out the period, quiet days included", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, THE_DAY);
    const overview = await overviewOf(db, workspaceId, site.id, PERIOD);
    expect(overview).toMatchObject({ from: "2026-10-30", to: "2026-11-05", timezone: "UTC", totals: { visitors: 3, pageViews: 4, events: 2, bounces: 2 } });
    expect(overview.days).toHaveLength(7);
    expect(overview.days.find(({ date }) => date === DAY)).toMatchObject({ pageViews: 4 });
    expect(overview.days.find(({ date }) => date === "2026-11-04")).toMatchObject({ pageViews: 0, visitors: 0 });
    expect(overview.pages[0]).toMatchObject({ value: "/", count: 2 });
    expect(overview.referrers[0]).toMatchObject({ value: "(direct)", count: 3 });
    expect(overview.utm.source[0]).toMatchObject({ value: "news", count: 1 });
    expect(overview.countries[0]).toMatchObject({ value: "FR", count: 3 });
    expect(overview.devices[0]).toMatchObject({ value: "mobile", count: 3 });
  });

  it("adds up a whole workspace, keeping the same path on two sites apart", async () => {
    const { workspaceId, userId, site } = await seat();
    const other = await addSite(db, workspaceId, userId, "Other", "other.example");
    await flushed(site, [collected({ path: "/", visitor: visitor(1) })]);
    await flushed(other, [collected({ path: "/", visitor: visitor(2) }), collected({ path: "/", visitor: visitor(2) })]);
    const overview = await overviewOf(db, workspaceId, null, PERIOD);
    expect(overview.totals).toMatchObject({ pageViews: 3, visitors: 2 });
    expect(overview.pages).toEqual([
      { value: "/", siteName: "Other", count: 2, visitors: 1 },
      { value: "/", siteName: "Acme", count: 1, visitors: 1 },
    ]);
  });

  it("adds a visitor up over days: the hash rotates, so a person on two days counts twice", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [collected({ visitor: visitor(1), at: at("08:00", "2026-11-02") }), collected({ visitor: visitor(2), at: at("08:00", "2026-11-03") })]);
    expect((await overviewOf(db, workspaceId, site.id, PERIOD)).totals.visitors).toBe(2);
  });

  it("is honest about being empty", async () => {
    const { workspaceId, site } = await seat();
    const overview = await overviewOf(db, workspaceId, site.id, PERIOD);
    expect(overview.lastWrittenAt).toBeNull();
    expect(overview.totals).toMatchObject({ pageViews: 0, visitors: 0 });
    expect(overview.pages).toEqual([]);
  });

  it("shows nothing of another workspace's sites", async () => {
    const mine = await seat("Mine");
    const theirs = await seat("Theirs");
    await flushed(theirs.site, THE_DAY);
    expect((await overviewOf(db, mine.workspaceId, theirs.site.id, PERIOD)).totals.pageViews).toBe(0);
    expect((await overviewOf(db, mine.workspaceId, null, PERIOD)).totals.pageViews).toBe(0);
    expect(await withWorkspace(db, mine.workspaceId, (tx) => topValues(tx, theirs.site.id, "page", PERIOD))).toEqual([]);
  });
});

describe("custom events", () => {
  it("are listed by how often they happened, each with its days", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [
      collected({ kind: "event", name: "a", at: at("08:00", "2026-11-02") }),
      collected({ kind: "event", name: "b", at: at("08:00", "2026-11-02") }),
      collected({ kind: "event", name: "b", at: at("08:00", "2026-11-03") }),
    ]);
    const { events } = await customEventsOf(db, workspaceId, site.id, PERIOD);
    expect(events.map(({ name, count }) => [name, count])).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
    expect(events[0].days.find(({ date }) => date === "2026-11-03")).toEqual({ date: "2026-11-03", count: 1 });
    expect(events[0].days).toHaveLength(7);
  });
});

describe("figures for a dashboard", () => {
  it("come per site and per day, with no pages and no people", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, THE_DAY);
    const figures = await figuresOf(db, workspaceId, PERIOD);
    expect(figures).toMatchObject({ from: "2026-10-30", to: "2026-11-05", timezone: "UTC" });
    expect(figures.sites).toHaveLength(1);
    expect(figures.sites[0].days.find(({ date }) => date === DAY)).toEqual({ date: DAY, visitors: 3, pageViews: 4, events: 2, bounces: 2 });
    expect(JSON.stringify(figures)).not.toContain("user_1");
    expect(JSON.stringify(figures)).not.toContain("/pricing");
  });

  it("can ask for one site", async () => {
    const { workspaceId, userId, site } = await seat();
    await addSite(db, workspaceId, userId, "Other", "other.example");
    expect((await figuresOf(db, workspaceId, PERIOD, site.id)).sites.map(({ id }) => id)).toEqual([site.id]);
    expect((await figuresOf(db, workspaceId, PERIOD)).sites).toHaveLength(2);
  });
});
