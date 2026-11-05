import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as flushRoute } from "@/app/api/cron/flush/route";
import { GET as retentionRoute } from "@/app/api/cron/retention/route";
import { whatIsScheduled } from "@/application/scheduled-work";
import { deleteSite } from "@/application/sites";
import type { Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/analytics";
import { SITES_TAG, sitesChanged } from "@/infrastructure/scheduling/scheduled-work";
import { addSite, batchOf, collected, memoryBuffer } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

const revalidateTag = vi.hoisted(() => vi.fn());
const shared = vi.hoisted(() => ({ db: undefined as unknown, cached: undefined as { hasSites: boolean } | undefined, secret: "cron-secret" as string | undefined, buffer: undefined as unknown }));
vi.mock("next/cache", () => ({ revalidateTag, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => shared.db }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => ({ CRON_SECRET: shared.secret }) }));
vi.mock("@/infrastructure/buffer", () => ({ eventBuffer: () => shared.buffer }));

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});
beforeEach(async () => {
  revalidateTag.mockReset();
  shared.db = db;
  shared.buffer = memoryBuffer();
  await db.delete(site);
});

const call = (route: typeof flushRoute, authorization?: string) => route(new Request("https://trailic.test/api/cron/flush", { headers: authorization ? { authorization } : {} }));
const scheduler = (route: typeof flushRoute) => call(route, "Bearer cron-secret");

describe("what the scheduled jobs have to do", () => {
  it("is nothing while there's no site", async () => {
    expect(await whatIsScheduled(db)).toEqual({ hasSites: false });
  });

  it("is something once there is one, in any workspace, and nothing again when it's gone", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const { id } = await addSite(db, workspaceId, userId);
    expect(await whatIsScheduled(db)).toEqual({ hasSites: true });
    await deleteSite(db, workspaceId, userId, id);
    expect(await whatIsScheduled(db)).toEqual({ hasSites: false });
  });
});

describe("what's known about sites", () => {
  it("is cleared at once, so the next reader doesn't get the old answer", () => {
    sitesChanged();
    expect(revalidateTag).toHaveBeenCalledWith(SITES_TAG, { expire: 0 });
  });

  it("doesn't stop anything outside a request, where nothing is cached to clear", () => {
    revalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    expect(() => sitesChanged()).not.toThrow();
  });
});

describe.each([
  ["flush", flushRoute],
  ["retention", retentionRoute],
])("the %s job's address", (_, route) => {
  it("is for the scheduler only", async () => {
    expect((await call(route)).status).toBe(401);
    expect((await call(route, "Bearer wrong")).status).toBe(401);
    shared.secret = undefined;
    expect((await call(route, "Bearer anything")).status).toBe(401);
    shared.secret = "cron-secret";
  });
});

describe("the flush job", () => {
  it("does its work", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await addSite(db, workspaceId, userId);
    await (shared.buffer as ReturnType<typeof memoryBuffer>).append(batchOf(made, [collected()]));
    const answer = await scheduler(flushRoute);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ batches: 1, events: 1, failed: 0 });
  });

  it("says so when writing failed, with the events still in the buffer", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await addSite(db, workspaceId, userId);
    const buffer = shared.buffer as ReturnType<typeof memoryBuffer>;
    await buffer.append(batchOf(made, [collected()]));
    const real = db;
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Answers "there are sites", then goes down for the flush itself.
    shared.db = new Proxy(real, { get: (target, property, receiver) => (property === "select" && !buffer.claims ? Reflect.get(target, property, receiver) : property === "select" ? () => { throw new Error("Connection refused"); } : Reflect.get(target, property, receiver)) });
    const answer = await scheduler(flushRoute);
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ failed: 1, events: 0 });
    expect(buffer.waiting).toHaveLength(1);
  });
});

describe("the retention job", () => {
  it("does its work", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await addSite(db, workspaceId, userId);
    expect(await (await scheduler(retentionRoute)).json()).toEqual({ partitionsDropped: 0, rowsDeleted: 0, peopleForgotten: 0 });
  });
});

describe("a database that doesn't answer", () => {
  it("makes the retention job say so, not hang", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    await addSite(db, workspaceId, userId);
    vi.useFakeTimers();
    shared.db = new Proxy(db, { get: (target, property, receiver) => (property === "execute" ? () => new Promise(() => {}) : Reflect.get(target, property, receiver)) });
    const answered = scheduler(retentionRoute);
    await vi.advanceTimersByTimeAsync(21_000);
    const answer = await answered;
    vi.useRealTimers();
    expect(answer.status).toBe(503);
  });

  it("is assumed to have work when nobody can say: the job finds out next", async () => {
    vi.useFakeTimers();
    shared.db = new Proxy(db, { get: (target, property, receiver) => (property === "select" ? () => ({ from: () => ({ limit: () => new Promise(() => {}) }) }) : Reflect.get(target, property, receiver)) });
    const answered = scheduler(flushRoute);
    await vi.advanceTimersByTimeAsync(3_100);
    const answer = await answered;
    vi.useRealTimers();
    expect(await answer.json()).toMatchObject({ idle: true });
  });
});
