import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushBuffer } from "@/application/flush";
import { overviewOf } from "@/application/overview";
import { erasePerson, peopleOf, personActivity } from "@/application/people";
import { deleteSite, updateSite } from "@/application/sites";
import { periodEndingAt } from "@/application/time-range";
import type { Database } from "@/infrastructure/db/client";
import { rowsOf } from "@/infrastructure/db/rows";
import { dailySite, event, flushedBatch, site as siteTable } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { addSite, batchOf, collected, memoryBuffer, NOW, untouchableDatabase, visitor } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

let buffer: ReturnType<typeof memoryBuffer>;
beforeEach(() => {
  buffer = memoryBuffer();
});

const services = () => ({ db, buffer, now: () => NOW });

async function seat(name = "Acme") {
  const { workspaceId, userId } = await createTestWorkspace(db, name);
  const site = await addSite(db, workspaceId, userId, name);
  return { workspaceId, userId, site };
}

const eventsOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(event));
const totalsOf = (workspaceId: string) => withWorkspace(db, workspaceId, (tx) => tx.select().from(dailySite));

describe("a flush with nothing waiting", () => {
  it("doesn't touch the database at all", async () => {
    const report = await flushBuffer({ db: untouchableDatabase(), buffer, now: () => NOW });
    expect(report).toMatchObject({ idle: true, batches: 0 });
  });
});

describe("a flush", () => {
  it("writes what's waiting, in one go, and empties the buffer", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ path: "/a" }), collected({ path: "/b" })]));
    await buffer.append(batchOf(site, [collected({ path: "/c" })]));
    const report = await flushBuffer(services());
    expect(report).toMatchObject({ idle: false, batches: 2, events: 3, duplicates: 0, dropped: 0, failed: 0 });
    expect(buffer.waiting).toEqual([]);
    expect((await eventsOf(workspaceId)).map(({ path }) => path).sort()).toEqual(["/a", "/b", "/c"]);
  });

  it("says when data was last written", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected()]));
    await flushBuffer(services());
    const overview = await overviewOf(db, workspaceId, site.id, periodEndingAt(NOW, 7));
    expect(overview.lastWrittenAt).toEqual(NOW);
  });

  it("keeps each workspace's events in its own workspace", async () => {
    const mine = await seat("Mine");
    const theirs = await seat("Theirs");
    await buffer.append(batchOf(mine.site, [collected({ path: "/mine" })]));
    await buffer.append(batchOf(theirs.site, [collected({ path: "/theirs" })]));
    await flushBuffer(services());
    expect((await eventsOf(mine.workspaceId)).map(({ path }) => path)).toEqual(["/mine"]);
    expect((await eventsOf(theirs.workspaceId)).map(({ path }) => path)).toEqual(["/theirs"]);
  });

  it("carries on through more than one round", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected()]));
    const claim = buffer.claim.bind(buffer);
    // Each round only sees one batch: a second appears while the first is being written.
    let rounds = 0;
    buffer.claim = async (max) => {
      rounds += 1;
      const claims = await claim(max);
      if (rounds === 1) await buffer.append(batchOf(site, [collected()]));
      return claims;
    };
    expect(await flushBuffer(services())).toMatchObject({ batches: 2, events: 2 });
    expect(await eventsOf(workspaceId)).toHaveLength(2);
  });

  it("stops at its time limit and leaves the rest for the next run", async () => {
    const { site } = await seat();
    await buffer.append(batchOf(site, [collected()]));
    const claim = buffer.claim.bind(buffer);
    buffer.claim = async (max) => {
      const claims = await claim(max);
      await buffer.append(batchOf(site, [collected()]));
      return claims;
    };
    const report = await flushBuffer(services(), -1);
    expect(report.batches).toBe(1);
    expect(buffer.waiting).toHaveLength(1);
  });
});

describe("nothing lost, nothing counted twice", () => {
  it("a batch delivered again is written once", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected()]));
    // The write commits, then the acknowledgement is lost: the buffer delivers it again.
    buffer.loseAcknowledgements = true;
    const first = await flushBuffer(services());
    expect(first.events).toBe(1);
    buffer.leasesExpire();
    expect(buffer.waiting).toHaveLength(1);
    buffer.loseAcknowledgements = false;
    const second = await flushBuffer(services());
    expect(second).toMatchObject({ events: 0, duplicates: 1, batches: 0 });
    expect(buffer.waiting).toEqual([]);
    expect(await eventsOf(workspaceId)).toHaveLength(1);
    expect((await totalsOf(workspaceId))[0]).toMatchObject({ pageViews: 1, visitors: 1 });
  });

  it("the same batch twice in one round is written once", async () => {
    const { workspaceId, site } = await seat();
    const batch = batchOf(site, [collected()]);
    await buffer.append(batch);
    await buffer.append(batch);
    expect(await flushBuffer(services())).toMatchObject({ events: 1, duplicates: 1 });
    expect(await eventsOf(workspaceId)).toHaveLength(1);
  });

  it("a write that fails halfway leaves nothing behind, and the retry writes it all", async () => {
    const { workspaceId, site } = await seat();
    // The site's rows are fine; the rollup step fails, after the events went in, as if the connection dropped.
    await buffer.append(batchOf(site, [collected(), collected({ path: "/b" })]));
    await db.execute(sql`alter table daily_site add constraint fail_for_a_test check (page_views < 0) not valid`);
    const failed = await flushBuffer(services());
    expect(failed).toMatchObject({ failed: 1, events: 0, batches: 0 });
    expect(buffer.waiting).toHaveLength(1);
    expect(await eventsOf(workspaceId)).toEqual([]);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(flushedBatch))).toEqual([]);
    await db.execute(sql`alter table daily_site drop constraint fail_for_a_test`);
    expect(await flushBuffer(services())).toMatchObject({ batches: 1, events: 2, failed: 0 });
    expect(await eventsOf(workspaceId)).toHaveLength(2);
    expect((await totalsOf(workspaceId))[0]).toMatchObject({ pageViews: 2 });
  });

  it("a database that doesn't answer loses nothing: everything goes back", async () => {
    const { site } = await seat();
    await buffer.append(batchOf(site, [collected()]));
    const down = new Proxy({} as Database, {
      get() {
        throw new Error("Connection refused");
      },
    });
    const report = await flushBuffer({ db: down, buffer, now: () => NOW });
    expect(report.failed).toBe(1);
    expect(buffer.waiting).toHaveLength(1);
    expect(await flushBuffer(services())).toMatchObject({ batches: 1, events: 1 });
  });

  it("one workspace failing doesn't hold another back", async () => {
    const mine = await seat("Mine");
    const theirs = await seat("Theirs");
    await buffer.append(batchOf(mine.site, [collected()]));
    await buffer.append(batchOf(theirs.site, [collected()]));
    await db.execute(sql.raw(`alter table daily_site add constraint fail_for_a_test check (site_id <> '${mine.site.id}') not valid`));
    const report = await flushBuffer(services());
    await db.execute(sql`alter table daily_site drop constraint fail_for_a_test`);
    expect(report).toMatchObject({ failed: 1, batches: 1 });
    expect(await eventsOf(mine.workspaceId)).toEqual([]);
    expect(await eventsOf(theirs.workspaceId)).toHaveLength(1);
    expect(buffer.waiting).toHaveLength(1);
    expect(await flushBuffer(services())).toMatchObject({ batches: 1, failed: 0 });
    expect(await eventsOf(mine.workspaceId)).toHaveLength(1);
  });

  it("many retries of a mix add up to exactly what was sent", async () => {
    const { workspaceId, site } = await seat();
    const sent = Array.from({ length: 25 }, (_, index) => batchOf(site, [collected({ visitor: visitor(index + 1) })]));
    for (const batch of sent) await buffer.append(batch);
    buffer.loseAcknowledgements = true;
    const inTens: typeof buffer = { ...buffer, claim: (max) => buffer.claim(Math.min(max, 10)) };
    await flushBuffer({ ...services(), buffer: inTens }, -1);
    buffer.leasesExpire();
    await flushBuffer({ ...services(), buffer: inTens }, -1);
    buffer.leasesExpire();
    buffer.loseAcknowledgements = false;
    await flushBuffer(services());
    expect(buffer.waiting).toEqual([]);
    expect(await eventsOf(workspaceId)).toHaveLength(25);
    expect((await totalsOf(workspaceId))[0]).toMatchObject({ pageViews: 25, visitors: 25 });
  });
});

describe("what a flush won't believe", () => {
  it("drops something that isn't a batch, once, without failing the rest", async () => {
    const { workspaceId, site } = await seat();
    buffer.waiting.push({ batch: { nonsense: true }, deliveries: 0 });
    await buffer.append(batchOf(site, [collected()]));
    expect(await flushBuffer(services())).toMatchObject({ dropped: 1, events: 1, failed: 0 });
    expect(buffer.waiting).toEqual([]);
    expect(await eventsOf(workspaceId)).toHaveLength(1);
  });

  it("drops a batch for a site that's been deleted", async () => {
    const { workspaceId, userId, site } = await seat();
    await buffer.append(batchOf(site, [collected()]));
    await deleteSite(db, workspaceId, userId, site.id);
    expect(await flushBuffer(services())).toMatchObject({ dropped: 1, events: 0, idle: false });
  });

  it("drops a batch sent with a key since replaced", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf({ ...site, key: "site_the_old_key" }, [collected()]));
    expect(await flushBuffer(services())).toMatchObject({ dropped: 1 });
    expect(await eventsOf(workspaceId)).toEqual([]);
  });

  it("checks the domain when the collector couldn't", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ path: "/elsewhere" })], { verified: false, originHost: "evil.example" }));
    await buffer.append(batchOf(site, [collected({ path: "/here" })], { verified: false, originHost: "www.acme.example" }));
    expect(await flushBuffer(services())).toMatchObject({ dropped: 1, events: 1 });
    expect((await eventsOf(workspaceId)).map(({ path }) => path)).toEqual(["/here"]);
  });

  it("drops events older than the site keeps, so a late batch can't rewrite a day that's gone", async () => {
    const { workspaceId, userId, site } = await seat();
    await updateSite(db, workspaceId, userId, site.id, { retentionDays: 14 });
    const old = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    await buffer.append(batchOf(site, [collected({ at: old, path: "/old" }), collected({ path: "/new" })]));
    expect(await flushBuffer(services())).toMatchObject({ events: 1 });
    expect((await eventsOf(workspaceId)).map(({ path }) => path)).toEqual(["/new"]);
  });
});

describe("partitions", () => {
  it("are made as events need them, one per month, each with row-level security", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ at: "2026-10-31T23:59:59.000Z" }), collected({ at: "2026-11-01T00:00:00.000Z" })]));
    await flushBuffer(services());
    const partitions = await rowsOf<{ name: string; secured: boolean }>(db, sql`select child.relname as name, child.relrowsecurity as secured from pg_inherits join pg_class child on child.oid = inhrelid join pg_class parent on parent.oid = inhparent where parent.relname = 'event' order by 1`);
    expect(partitions.map(({ name }) => name)).toEqual(expect.arrayContaining(["event_2026_10", "event_2026_11"]));
    expect(partitions.every(({ secured }) => secured)).toBe(true);
    expect(await eventsOf(workspaceId)).toHaveLength(2);
  });

  it("are made once, however often they're asked for", async () => {
    await db.execute(sql`select ensure_event_partition('2026-09-15'::date)`);
    await db.execute(sql`select ensure_event_partition('2026-09-20'::date)`);
    const [{ count }] = await rowsOf<{ count: number }>(db, sql`select count(*)::int as count from pg_tables where tablename = 'event_2026_09'`);
    expect(count).toBe(1);
  });

  it("can't be made by the app role", async () => {
    const { workspaceId } = await seat();
    await expect(withWorkspace(db, workspaceId, (tx) => tx.execute(sql`select ensure_event_partition('2030-01-01'::date)`))).rejects.toThrow();
  });
});

describe("identifying someone", () => {
  const SITE_DAY = "2026-11-05";
  const at = (time: string) => `${SITE_DAY}T${time}:00.000Z`;

  it("records them, with what the site said, keeping the earliest and latest", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ kind: "identify", path: "/account", userId: "user_1", traits: { plan: "pro" }, at: at("08:00") }), collected({ userId: "user_1", at: at("08:30") })]));
    await flushBuffer(services());
    await buffer.append(batchOf(site, [collected({ kind: "identify", userId: "user_1", traits: { seats: 3 }, at: at("07:00") })]));
    await flushBuffer(services());
    const [person] = await peopleOf(db, workspaceId, site.id);
    expect(person).toMatchObject({ userId: "user_1", traits: { plan: "pro", seats: 3 } });
    expect(person.firstSeenAt.toISOString()).toBe(at("07:00"));
    expect(person.lastSeenAt.toISOString()).toBe(at("08:30"));
  });

  it("makes the half hour before theirs, on the same device, and nothing older", async () => {
    const { workspaceId, site } = await seat();
    const anonymous = visitor(7);
    await buffer.append(batchOf(site, [
      collected({ visitor: anonymous, path: "/long-before", at: at("07:00") }),
      collected({ visitor: anonymous, path: "/just-before", at: at("07:50") }),
      collected({ visitor: visitor(8), path: "/someone-else", at: at("07:55") }),
    ]));
    await flushBuffer(services());
    await buffer.append(batchOf(site, [collected({ kind: "identify", visitor: anonymous, userId: "user_1", path: "/signed-in", at: at("08:00") })]));
    await flushBuffer(services());
    const rows = await eventsOf(workspaceId);
    const owner = (path: string) => rows.find((row) => row.path === path)?.userId;
    expect(owner("/just-before")).toBe("user_1");
    expect(owner("/long-before")).toBeNull();
    expect(owner("/someone-else")).toBeNull();
  });

  it("counts them once, whatever device they use", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ visitor: visitor(1), userId: "user_1" }), collected({ visitor: visitor(2), userId: "user_1" })]));
    await flushBuffer(services());
    expect((await totalsOf(workspaceId))[0]).toMatchObject({ visitors: 1, pageViews: 2 });
  });
});

describe("one person", () => {
  it("has their recent activity, newest first, and nobody else's", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ userId: "user_1", path: "/first", at: "2026-11-05T08:00:00.000Z" }), collected({ kind: "event", name: "signup", userId: "user_1", path: "/first", at: "2026-11-05T08:01:00.000Z", props: { plan: "pro" } }), collected({ userId: "user_2", path: "/theirs", visitor: visitor(2) })]));
    await flushBuffer(services());
    const found = await personActivity(db, workspaceId, site.id, "user_1");
    expect(found?.person.userId).toBe("user_1");
    expect(found?.events.map(({ kind, path, name }) => [kind, path, name])).toEqual([["event", "/first", "signup"], ["page", "/first", null]]);
    expect(found?.events[0].props).toEqual({ plan: "pro" });
  });

  it("can be found by part of their id, with no wildcards smuggled in", async () => {
    const { workspaceId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ userId: "alpha_1" }), collected({ userId: "beta%2", visitor: visitor(2) })]));
    await flushBuffer(services());
    expect((await peopleOf(db, workspaceId, site.id, "ALPHA")).map(({ userId }) => userId)).toEqual(["alpha_1"]);
    expect((await peopleOf(db, workspaceId, site.id, "%")).map(({ userId }) => userId)).toEqual(["beta%2"]);
    expect(await peopleOf(db, workspaceId, site.id, "nobody")).toEqual([]);
  });
});

describe("erasing someone", () => {
  const person = "user_erased";

  async function identified() {
    const context = await seat();
    await buffer.append(batchOf(context.site, [collected({ kind: "identify", userId: person, traits: { email: "ada@acme.example" } }), collected({ userId: person, path: "/secret" }), collected({ visitor: visitor(9), path: "/other" })]));
    await flushBuffer(services());
    return context;
  }

  it("removes their events and what was said about them, and their part in the day", async () => {
    const { workspaceId, userId, site } = await identified();
    expect((await totalsOf(workspaceId))[0]).toMatchObject({ visitors: 2, pageViews: 2 });
    const erased = await erasePerson(db, workspaceId, userId, site.id, person, NOW);
    expect(erased.ok).toBe(true);
    expect(await personActivity(db, workspaceId, site.id, person)).toBeNull();
    const left = await eventsOf(workspaceId);
    expect(left.map(({ path }) => path)).toEqual(["/other"]);
    expect(JSON.stringify(left)).not.toContain(person);
    expect((await totalsOf(workspaceId))[0]).toMatchObject({ visitors: 1, pageViews: 1 });
  });

  it("keeps what's still in the buffer about them from coming back", async () => {
    const { workspaceId, userId, site } = await identified();
    const stillOnItsWay = batchOf(site, [collected({ userId: person, path: "/late", at: new Date(NOW.getTime() - 60_000).toISOString() })]);
    await buffer.append(stillOnItsWay);
    await erasePerson(db, workspaceId, userId, site.id, person, NOW);
    await flushBuffer(services());
    expect(JSON.stringify(await eventsOf(workspaceId))).not.toContain(person);
    expect(await peopleOf(db, workspaceId, site.id)).toEqual([]);
  });

  it("keeps a hash of who, never the id", async () => {
    const { workspaceId, userId, site } = await identified();
    await erasePerson(db, workspaceId, userId, site.id, person, NOW);
    const rows = await withWorkspace(db, workspaceId, (tx) => rowsOf<Record<string, unknown>>(tx, sql`select * from erased_person`));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(person);
  });

  it("lets them come back later, as someone new", async () => {
    const { workspaceId, userId, site } = await identified();
    await erasePerson(db, workspaceId, userId, site.id, person, NOW);
    await buffer.append(batchOf(site, [collected({ userId: person, at: new Date(NOW.getTime() + 60_000).toISOString() })]));
    await flushBuffer({ ...services(), now: () => new Date(NOW.getTime() + 120_000) });
    expect(await peopleOf(db, workspaceId, site.id)).toHaveLength(1);
  });

  it("is for owners and admins, and says when there's nobody by that id", async () => {
    const { workspaceId, userId, site } = await identified();
    const { userId: stranger } = await createTestWorkspace(db, "Other");
    expect((await erasePerson(db, workspaceId, stranger, site.id, person, NOW)).ok).toBe(false);
    expect(await peopleOf(db, workspaceId, site.id)).toHaveLength(1);
    expect((await erasePerson(db, workspaceId, userId, site.id, "user_nobody", NOW)).ok).toBe(false);
  });

  it("can't reach another workspace's people", async () => {
    const mine = await identified();
    const theirs = await seat("Theirs");
    await erasePerson(db, theirs.workspaceId, theirs.userId, mine.site.id, person, NOW).catch(() => {});
    expect(await peopleOf(db, mine.workspaceId, mine.site.id)).toHaveLength(1);
  });
});

describe("deleting a site", () => {
  it("takes its events, rollups and people with it, partitions or not", async () => {
    const { workspaceId, userId, site } = await seat();
    await buffer.append(batchOf(site, [collected({ userId: "user_1" })]));
    await flushBuffer(services());
    expect((await deleteSite(db, workspaceId, userId, site.id)).ok).toBe(true);
    expect(await eventsOf(workspaceId)).toEqual([]);
    expect(await totalsOf(workspaceId)).toEqual([]);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(siteTable))).toEqual([]);
  });
});

describe("a database that has stopped answering", () => {
  it("doesn't hang a flush: what it claimed goes back, soon", async () => {
    const { site } = await seat();
    await buffer.append(batchOf(site, [collected()]));
    const frozen = new Proxy({} as Database, {
      get: (_, property) => (property === "execute" ? () => new Promise(() => {}) : undefined),
    });
    const report = await flushBuffer({ db: frozen, buffer, now: () => NOW }, undefined, 10);
    expect(report.failed).toBe(1);
    expect(buffer.waiting).toHaveLength(1);
  });
});

describe("a workspace failing, with more waiting behind it", () => {
  const failingFor = (siteId: string) => db.execute(sql.raw(`alter table daily_site add constraint fail_for_a_test check (site_id <> '${siteId}') not valid`));
  const failingNoMore = () => db.execute(sql`alter table daily_site drop constraint fail_for_a_test`);
  const inOnes = () => ({ ...buffer, claim: () => buffer.claim(1) });

  it("doesn't stop the flush for what comes after it in the queue", async () => {
    const [broken, fine] = [await seat("Broken"), await seat("Fine")];
    await buffer.append(batchOf(broken.site, [collected()]));
    await buffer.append(batchOf(fine.site, [collected()]));
    await buffer.append(batchOf(fine.site, [collected()]));
    await failingFor(broken.site.id);
    const report = await flushBuffer({ ...services(), buffer: inOnes() }).finally(failingNoMore);
    expect(report).toMatchObject({ failed: 1, batches: 2, events: 2 });
    expect(await eventsOf(fine.workspaceId)).toHaveLength(2);
    expect(await eventsOf(broken.workspaceId)).toEqual([]);
    expect(buffer.waiting).toHaveLength(1);
  });

  it("isn't tried again in the same run, and everything it held goes back once the run ends", async () => {
    const broken = await seat("Broken");
    const first = batchOf(broken.site, [collected()]);
    await buffer.append(first);
    await buffer.append(batchOf(broken.site, [collected()]));
    await failingFor(broken.site.id);
    const report = await flushBuffer({ ...services(), buffer: inOnes() }).finally(failingNoMore);
    expect(report).toMatchObject({ failed: 2, batches: 0 });
    expect(buffer.waiting).toHaveLength(2);
    expect(buffer.claims).toBe(3);
    expect(await flushBuffer(services())).toMatchObject({ batches: 2, failed: 0 });
    expect(await eventsOf(broken.workspaceId)).toHaveLength(2);
  });

  it("isn't everyone's problem when what it holds can't get a partition", async () => {
    const [odd, fine] = [await seat("Odd"), await seat("Fine")];
    await buffer.append(batchOf(odd.site, [collected({ at: "0000-01-15T00:00:00.000Z" })]));
    await buffer.append(batchOf(fine.site, [collected()]));
    const report = await flushBuffer(services());
    expect(report).toMatchObject({ batches: 2, events: 1, failed: 0 });
    expect(await eventsOf(fine.workspaceId)).toHaveLength(1);
    expect(buffer.waiting).toEqual([]);
  });
});
