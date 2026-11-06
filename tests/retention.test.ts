import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushBuffer } from "@/application/flush";
import { peopleOf } from "@/application/people";
import { applyRetention } from "@/application/retention";
import { updateSite } from "@/application/sites";
import type { Database } from "@/infrastructure/db/client";
import { eventPartitionMonths, monthAfter } from "@/infrastructure/db/partitions";
import { dailySite, erasedPerson, event, flushedBatch } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { addSite, batchOf, collected, memoryBuffer, NOW } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;
beforeEach(async () => {
  db = await createTestDatabase();
});

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

async function seat(name = "Acme") {
  const { workspaceId, userId } = await createTestWorkspace(db, name);
  const site = await addSite(db, workspaceId, userId, name);
  return { workspaceId, userId, site };
}

/** Writes events as long ago as they say: a flush at that time, so its own retention lets them through. */
async function flushed(site: { id: string; key: string }, events: ReturnType<typeof collected>[]) {
  const buffer = memoryBuffer();
  await buffer.append(batchOf(site, events));
  const at = new Date(Math.min(...events.map(({ at }) => new Date(at).getTime())));
  await flushBuffer({ db, buffer, now: () => at });
}

const rawDays = async (workspaceId: string) => (await withWorkspace(db, workspaceId, (tx) => tx.select({ at: event.at }).from(event))).map(({ at }) => Math.round((NOW.getTime() - at.getTime()) / 86_400_000)).sort((a, b) => a - b);

describe("raw events", () => {
  it("go after the default 90 days, and rollups stay", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [collected({ at: daysAgo(100) })]);
    await flushed(site, [collected({ at: daysAgo(80) })]);
    await flushed(site, [collected({ at: daysAgo(1) })]);
    const report = await applyRetention(db, NOW);
    expect(report.rowsDeleted + report.partitionsDropped).toBeGreaterThan(0);
    expect(await rawDays(workspaceId)).toEqual([1, 80]);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(dailySite))).toHaveLength(3);
  });

  it("follow each site's own retention", async () => {
    const { workspaceId, userId, site } = await seat();
    const keeper = await addSite(db, workspaceId, userId, "Keeper", "keeper.example");
    await updateSite(db, workspaceId, userId, site.id, { retentionDays: 30 });
    await updateSite(db, workspaceId, userId, keeper.id, { retentionDays: 365 });
    await flushed(site, [collected({ at: daysAgo(40) })]);
    await flushed(keeper, [collected({ at: daysAgo(40) })]);
    await applyRetention(db, NOW);
    const left = await withWorkspace(db, workspaceId, (tx) => tx.select({ siteId: event.siteId }).from(event));
    expect(left.map(({ siteId }) => siteId)).toEqual([keeper.id]);
  });

  it("go by the whole day, so a day is either all there or gone", async () => {
    const { workspaceId, site } = await seat();
    const lastKept = "2026-08-07";
    await flushed(site, [collected({ at: `${lastKept}T00:00:00.000Z` }), collected({ at: `${lastKept}T23:00:00.000Z` })]);
    await flushed(site, [collected({ at: "2026-08-06T23:59:59.000Z" })]);
    await applyRetention(db, NOW);
    expect(await withWorkspace(db, workspaceId, async (tx) => (await tx.select().from(event)).length)).toBe(2);
  });

  it("stay put when they're young enough, and it can run again with nothing to do", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [collected({ at: daysAgo(1) })]);
    expect(await applyRetention(db, NOW)).toEqual({ partitionsDropped: 0, rowsDeleted: 0, peopleForgotten: 0, failed: 0 });
    expect(await applyRetention(db, NOW)).toEqual({ partitionsDropped: 0, rowsDeleted: 0, peopleForgotten: 0, failed: 0 });
    expect(await rawDays(workspaceId)).toEqual([1]);
  });
});

describe("partitions", () => {
  it("are dropped when no site keeps anything from their month, and kept while one does", async () => {
    const { workspaceId, userId, site } = await seat();
    await updateSite(db, workspaceId, userId, site.id, { retentionDays: 30 });
    const keeper = await seat("Keeper");
    await updateSite(db, keeper.workspaceId, keeper.userId, keeper.site.id, { retentionDays: 60 });
    await flushed(site, [collected({ at: "2026-07-15T10:00:00.000Z" })]);
    await flushed(site, [collected({ at: "2026-09-20T10:00:00.000Z" })]);
    await flushed(keeper.site, [collected({ at: "2026-09-20T10:00:00.000Z" })]);
    expect(await eventPartitionMonths(db)).toEqual(["2026-07-01", "2026-09-01"]);
    const report = await applyRetention(db, NOW);
    expect(report.partitionsDropped).toBe(1);
    expect(await eventPartitionMonths(db)).toEqual(["2026-09-01"]);
    expect(await rawDays(workspaceId)).toEqual([]);
    expect(await rawDays(keeper.workspaceId)).toHaveLength(1);
  });

  it("work out the month after, over a new year", () => {
    expect(monthAfter("2026-12-01")).toBe("2027-01-01");
    expect(monthAfter("2026-01-01")).toBe("2026-02-01");
  });
});

describe("what else ages", () => {
  it("forgets someone unseen for as long as the site keeps events, traits and all", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [collected({ kind: "identify", userId: "gone", traits: { plan: "pro" }, at: daysAgo(120) })]);
    await flushed(site, [collected({ kind: "identify", userId: "here", at: daysAgo(1) })]);
    const report = await applyRetention(db, NOW);
    expect(report.peopleForgotten).toBe(1);
    expect((await peopleOf(db, workspaceId, site.id)).map(({ userId }) => userId)).toEqual(["here"]);
  });

  it("clears the ledger and erasures once a buffer can't hold anything that old", async () => {
    const { workspaceId, site } = await seat();
    const old = new Date(NOW.getTime() - 9 * 86_400_000);
    await withWorkspace(db, workspaceId, async (tx) => {
      await tx.insert(flushedBatch).values([{ batchId: crypto.randomUUID(), flushedAt: old }, { batchId: crypto.randomUUID(), flushedAt: NOW }]);
      await tx.insert(erasedPerson).values([{ siteId: site.id, userHash: "old", erasedAt: old }, { siteId: site.id, userHash: "new", erasedAt: NOW }]);
    });
    await applyRetention(db, NOW);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(flushedBatch))).toHaveLength(1);
    expect((await withWorkspace(db, workspaceId, (tx) => tx.select().from(erasedPerson))).map(({ userHash }) => userHash)).toEqual(["new"]);
  });

  it("does nothing with no sites", async () => {
    expect(await applyRetention(db, NOW)).toEqual({ partitionsDropped: 0, rowsDeleted: 0, peopleForgotten: 0, failed: 0 });
  });
});

describe("rollups, after their raw rows have gone", () => {
  it("still answer", async () => {
    const { workspaceId, site } = await seat();
    await flushed(site, [collected({ at: daysAgo(100), path: "/old" })]);
    await applyRetention(db, NOW);
    expect(await rawDays(workspaceId)).toEqual([]);
    const rows = await withWorkspace(db, workspaceId, (tx) => tx.execute(sql`select value, count from daily_dimension where dimension = 'page'`));
    expect(JSON.stringify(rows)).toContain("/old");
  });
});

describe("a site that can't be trimmed", () => {
  it("doesn't keep the others from being trimmed, says so, and comes round again on the next run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const [broken, fine] = [await seat("Broken"), await seat("Fine")];
    await flushed(broken.site, [collected({ at: daysAgo(95), userId: "someone" })]);
    await flushed(fine.site, [collected({ at: daysAgo(95) })]);
    await flushed(fine.site, [collected({ at: daysAgo(1) })]);
    await db.execute(sql.raw(`create function fail_for_a_test() returns trigger language plpgsql as $$ begin raise exception 'no'; end $$`));
    await db.execute(sql.raw(`create trigger fail_for_a_test before delete on person for each row when (old.site_id = '${broken.site.id}') execute function fail_for_a_test()`));
    const report = await applyRetention(db, NOW);
    expect(report.failed).toBe(1);
    expect(await rawDays(fine.workspaceId)).toEqual([1]);
    expect(await rawDays(broken.workspaceId)).toEqual([95]);
    await db.execute(sql`drop trigger fail_for_a_test on person`);
    expect((await applyRetention(db, NOW)).failed).toBe(0);
    expect(await rawDays(broken.workspaceId)).toEqual([]);
    error.mockRestore();
  });
});
