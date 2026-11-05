import { beforeAll, describe, expect, it } from "vitest";
import { retentionOf } from "@/application/cohorts";
import { flushBuffer } from "@/application/flush";
import { journeysOf, JOURNEY_DEPTH } from "@/application/journeys";
import { periodEndingAt } from "@/application/time-range";
import { cohortTable, weekOf, weeksEndingAt } from "@/domain/cohorts";
import type { Database } from "@/infrastructure/db/client";
import { addSite, batchOf, collected, memoryBuffer, NOW, visitor } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

async function seat(name = "Acme") {
  const { workspaceId, userId } = await createTestWorkspace(db, name);
  const site = await addSite(db, workspaceId, userId, name);
  return { workspaceId, userId, site };
}

async function flushed(site: { id: string; key: string }, events: ReturnType<typeof collected>[]) {
  const buffer = memoryBuffer();
  await buffer.append(batchOf(site, events));
  await flushBuffer({ db, buffer, now: () => NOW });
}

const active = (userId: string, day: string) => collected({ userId, at: `${day}T10:00:00.000Z` });

describe("weeks", () => {
  it("start on a Monday, in UTC", () => {
    expect(weekOf(new Date("2026-11-02T00:00:00Z"))).toBe("2026-11-02");
    expect(weekOf(new Date("2026-11-05T09:00:00Z"))).toBe("2026-11-02");
    expect(weekOf(new Date("2026-11-08T23:59:59Z"))).toBe("2026-11-02");
    expect(weekOf(new Date("2026-11-09T00:00:00Z"))).toBe("2026-11-09");
  });

  it("count back from this one", () => {
    expect(weeksEndingAt(NOW, 3)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02"]);
  });

  it("lay out a triangle: the newest cohort has one week behind it", () => {
    const rows = cohortTable(["2026-10-26", "2026-11-02"], new Map([["2026-10-26", 4]]), [{ cohort: "2026-10-26", offset: 1, people: 2 }]);
    expect(rows).toEqual([
      { week: "2026-10-26", size: 4, returned: [0, 2] },
      { week: "2026-11-02", size: 0, returned: [0] },
    ]);
  });
});

describe("retention, worked out by hand", () => {
  /**
   * Weeks starting 12, 19, 26 October and 2 November; now is Thursday 5 November.
   *   u1: first 12 Oct, back 19 Oct and 2 Nov, and does `report` on 19 Oct
   *   u2: first 13 Oct, back 26 Oct
   *   u3: first 19 Oct, twice that week, back 26 Oct
   *   u4: first 3 Nov
   *   an anonymous visitor comes all four weeks: nobody can say it's the same one
   */
  const FIXTURE = [
    active("u1", "2026-10-12"), active("u1", "2026-10-19"), collected({ kind: "event", name: "report", userId: "u1", at: "2026-10-20T10:00:00.000Z" }), active("u1", "2026-11-02"),
    active("u2", "2026-10-13"), active("u2", "2026-10-26"),
    active("u3", "2026-10-19"), active("u3", "2026-10-20"), active("u3", "2026-10-26"),
    active("u4", "2026-11-03"),
    ...["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"].map((day) => collected({ visitor: visitor(50), at: `${day}T10:00:00.000Z` })),
  ];

  it("by any activity", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, FIXTURE);
    const { cohorts, returnedBy, timezone } = await retentionOf(db, workspaceId, { siteId: site.id, weeks: 4, now: NOW });
    expect(returnedBy).toBe("any activity");
    expect(timezone).toBe("UTC");
    expect(cohorts).toEqual([
      { week: "2026-10-12", size: 2, returned: [2, 1, 1, 1] },
      { week: "2026-10-19", size: 1, returned: [1, 1, 0] },
      { week: "2026-10-26", size: 0, returned: [0, 0] },
      { week: "2026-11-02", size: 1, returned: [1] },
    ]);
  });

  it("by a chosen event", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, FIXTURE);
    const { cohorts, returnedBy } = await retentionOf(db, workspaceId, { siteId: site.id, weeks: 4, eventName: "report", now: NOW });
    expect(returnedBy).toBe("event report");
    expect(cohorts[0]).toEqual({ week: "2026-10-12", size: 2, returned: [0, 1, 0, 0] });
    expect(cohorts[1]).toEqual({ week: "2026-10-19", size: 1, returned: [0, 0, 0] });
  });

  it("leaves out people first seen before the weeks asked for", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, FIXTURE);
    const { cohorts } = await retentionOf(db, workspaceId, { siteId: site.id, weeks: 2, now: NOW });
    expect(cohorts).toEqual([
      { week: "2026-10-26", size: 0, returned: [0, 0] },
      { week: "2026-11-02", size: 1, returned: [1] },
    ]);
  });

  it("stays in its workspace", async () => {
    const mine = await seat("Mine");
    const theirs = await seat("Theirs");
    await flushed(theirs.site, FIXTURE);
    const { cohorts } = await retentionOf(db, mine.workspaceId, { siteId: theirs.site.id, weeks: 4, now: NOW });
    expect(cohorts.every(({ size, returned }) => size === 0 && returned.every((people) => people === 0))).toBe(true);
  });
});

describe("journeys, worked out by hand", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 3, 9, minutes)).toISOString();
  const page = (path: string, who: number, minutes: number) => collected({ path, visitor: visitor(who), at: t(minutes) });

  /**
   * From /home:
   *   1 and 2: /pricing, /signup
   *   3 and 6: /docs (6 had seen /pricing before /home, which doesn't count)
   *   4: nothing, 5: /pricing 31 minutes later, too late, so nothing
   * So 6 visits: three paths, two each.
   */
  const FIXTURE = [
    page("/home", 1, 0), page("/pricing", 1, 1), page("/signup", 1, 2),
    page("/home", 2, 0), page("/pricing", 2, 5), page("/signup", 2, 9),
    page("/home", 3, 0), page("/docs", 3, 1),
    page("/home", 4, 0),
    page("/home", 5, 0), page("/pricing", 5, 31),
    page("/pricing", 6, 0), page("/home", 6, 1), page("/docs", 6, 2),
  ];
  const PERIOD = periodEndingAt(NOW, 30);

  it("finds the most common paths onward from a page", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, FIXTURE);
    const report = await journeysOf(db, workspaceId, { siteId: site.id, startPath: "/home", period: PERIOD });
    expect(report.visits).toBe(6);
    expect(report.journeys).toHaveLength(3);
    expect(report.journeys).toEqual(expect.arrayContaining([{ next: ["/pricing", "/signup"], visits: 2 }, { next: ["/docs"], visits: 2 }, { next: [], visits: 2 }]));
  });

  it("follows a few pages, not a whole session", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/home", 1, 0), page("/a", 1, 1), page("/b", 1, 2), page("/c", 1, 3), page("/d", 1, 4)]);
    const { journeys } = await journeysOf(db, workspaceId, { siteId: site.id, startPath: "/home", period: PERIOD });
    expect(journeys).toEqual([{ next: ["/a", "/b", "/c"], visits: 1 }]);
    expect(JOURNEY_DEPTH).toBe(3);
  });

  it("starts from their first time on the page that day, once", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/home", 1, 0), page("/a", 1, 1), page("/home", 1, 2), page("/b", 1, 3)]);
    const { journeys, visits } = await journeysOf(db, workspaceId, { siteId: site.id, startPath: "/home", period: PERIOD });
    expect(visits).toBe(1);
    expect(journeys).toEqual([{ next: ["/a", "/home", "/b"], visits: 1 }]);
  });

  it("ignores custom events along the way", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [page("/home", 1, 0), collected({ kind: "event", name: "click", path: "/home", visitor: visitor(1), at: t(1) }), page("/a", 1, 2)]);
    const { journeys } = await journeysOf(db, workspaceId, { siteId: site.id, startPath: "/home", period: PERIOD });
    expect(journeys).toEqual([{ next: ["/a"], visits: 1 }]);
  });

  it("finds nothing from a page nobody saw, and nothing of another workspace", async () => {
    const mine = await seat("Mine");
    const theirs = await seat("Theirs");
    await flushed(theirs.site, FIXTURE);
    expect(await journeysOf(db, theirs.workspaceId, { siteId: theirs.site.id, startPath: "/nowhere", period: PERIOD })).toMatchObject({ visits: 0, journeys: [] });
    expect(await journeysOf(db, mine.workspaceId, { siteId: theirs.site.id, startPath: "/home", period: PERIOD })).toMatchObject({ visits: 0, journeys: [] });
  });
});
