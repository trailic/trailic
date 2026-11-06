import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as breakdownRoute } from "@/app/api/v1/figures/breakdown/route";
import { GET } from "@/app/api/v1/figures/route";
import { accessOfKey, apiKeysOf, bearerOf, createApiKey, revokeApiKey } from "@/application/api-keys";
import { flushBuffer } from "@/application/flush";
import { periodEndingAt } from "@/application/time-range";
import type { Database } from "@/infrastructure/db/client";
import { member } from "@/infrastructure/db/schema/tenancy";
import { addSite, batchOf, collected, memoryBuffer, NOW } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

const shared = vi.hoisted(() => ({ services: undefined as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  shared.services = { db, now: () => NOW };
});

const figures = (key: string | null, query = "") => GET(new Request(`https://trailic.test/api/v1/figures${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }));

async function seat(name = "Acme") {
  const { workspaceId, userId } = await createTestWorkspace(db, name);
  const site = await addSite(db, workspaceId, userId, name);
  const buffer = memoryBuffer();
  await buffer.append(batchOf(site, [collected(), collected({ path: "/b" })]));
  await flushBuffer({ db, buffer, now: () => NOW });
  const made = await createApiKey(db, workspaceId, userId, "Dashboard", ["figures:read"]);
  if (!made.ok) throw new Error(made.error);
  return { workspaceId, userId, site, key: made.key, keyId: made.id };
}

describe("an API key", () => {
  it("is shown once, and only its hash is kept", async () => {
    const { workspaceId, key } = await seat();
    const [row] = await apiKeysOf(db, workspaceId);
    expect(key.startsWith("sk_")).toBe(true);
    expect(key.startsWith(row.prefix)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(key);
  });

  it("needs a name's worth of asking, something to do, and someone who runs the workspace", async () => {
    const { workspaceId, userId } = await seat();
    expect(await createApiKey(db, workspaceId, userId, "None", [])).toMatchObject({ ok: false });
    expect(await createApiKey(db, workspaceId, userId, "Unknown", ["everything"])).toMatchObject({ ok: false });
    const { userId: mate } = await createTestWorkspace(db, "Mate's own");
    await db.insert(member).values({ workspaceId, userId: mate, role: "member" });
    expect(await createApiKey(db, workspaceId, mate, "Mine", ["figures:read"])).toMatchObject({ ok: false });
    expect(await revokeApiKey(db, workspaceId, mate, crypto.randomUUID())).toBe(false);
  });

  it("says which workspace it opens, and notes that it was used", async () => {
    const { workspaceId, key } = await seat();
    expect(await accessOfKey(db, key, "figures:read")).toMatchObject({ status: "ok", workspaceId });
    expect((await apiKeysOf(db, workspaceId))[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it("is refused when it's unknown, and without touching the database when it isn't even a key", async () => {
    await expect(accessOfKey(db, "sk_unknown", "figures:read")).resolves.toEqual({ status: "unknown" });
    await expect(accessOfKey(null as unknown as Database, "not-a-key", "figures:read")).resolves.toEqual({ status: "unknown" });
    await expect(accessOfKey(null as unknown as Database, null, "figures:read")).resolves.toEqual({ status: "unknown" });
  });

  it("stops working when it's revoked", async () => {
    const { workspaceId, userId, key, keyId } = await seat();
    expect(await revokeApiKey(db, workspaceId, userId, keyId)).toBe(true);
    expect(await accessOfKey(db, key, "figures:read")).toEqual({ status: "unknown" });
    expect(await revokeApiKey(db, workspaceId, userId, keyId)).toBe(false);
  });

  it("is read from the Authorization header", () => {
    expect(bearerOf(new Request("https://trailic.test", { headers: { authorization: "Bearer sk_x" } }))).toBe("sk_x");
    expect(bearerOf(new Request("https://trailic.test"))).toBeNull();
  });
});

describe("GET /api/v1/figures", () => {
  it("answers per site and per day, for the key's workspace only", async () => {
    const mine = await seat("Mine");
    await seat("Theirs");
    const answer = await figures(mine.key, "?days=2");
    expect(answer.status).toBe(200);
    const body = await answer.json();
    expect(body).toMatchObject({ workspace: { id: mine.workspaceId, name: "Mine" }, from: "2026-11-04", to: "2026-11-05", timezone: "UTC" });
    expect(body.sites.map(({ name }: { name: string }) => name)).toEqual(["Mine"]);
    expect(body.sites[0].days).toEqual([
      { date: "2026-11-04", visitors: 0, pageViews: 0, events: 0, bounces: 0 },
      { date: "2026-11-05", visitors: 1, pageViews: 2, events: 0, bounces: 0 },
    ]);
  });

  it("can ask for one site, and finds nothing of another workspace's", async () => {
    const mine = await seat("Mine");
    const theirs = await seat("Theirs");
    expect((await (await figures(mine.key, `?site=${mine.site.id}`)).json()).sites).toHaveLength(1);
    expect((await (await figures(mine.key, `?site=${theirs.site.id}`)).json()).sites).toEqual([]);
  });

  it("refuses no key, an unknown key, and a site that isn't an id", async () => {
    const { key } = await seat();
    expect((await figures(null)).status).toBe(401);
    expect((await figures("sk_unknown")).status).toBe(401);
    expect((await figures(key, "?site=nonsense")).status).toBe(400);
  });

  it("keeps to the days it may", async () => {
    const { key } = await seat();
    expect((await (await figures(key, "?days=9999")).json()).sites[0].days).toHaveLength(365);
    expect((await (await figures(key, "?days=nonsense")).json()).sites[0].days).toHaveLength(periodEndingAt(NOW, 30).days.length);
  });
});

describe("GET /api/v1/figures/breakdown", () => {
  const breakdown = (key: string | null, query = "") => breakdownRoute(new Request(`https://trailic.test/api/v1/figures/breakdown${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }));

  /** A workspace's site that had two views of /pricing by one visitor and one signup on the day of NOW. */
  async function withPricing(name = "Acme") {
    const seated = await seat(name);
    const buffer = memoryBuffer();
    await buffer.append(batchOf(seated.site, [collected({ path: "/pricing" }), collected({ path: "/pricing" }), collected({ kind: "event", name: "signup", path: "/pricing" })]));
    await flushBuffer({ db, buffer, now: () => NOW });
    return seated;
  }

  it("says a page's views and visitors per day, every day of the period", async () => {
    const { key, site } = await withPricing();
    const answer = await breakdown(key, `?site=${site.id}&dimension=page&value=/pricing&days=2`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      site: { id: site.id, name: "Acme" },
      dimension: "page",
      value: "/pricing",
      from: "2026-11-04",
      to: "2026-11-05",
      timezone: "UTC",
      days: [
        { date: "2026-11-04", count: 0, visitors: 0 },
        { date: "2026-11-05", count: 2, visitors: 1 },
      ],
    });
  });

  it("says a custom event's occurrences, and nothing of a name nobody sent", async () => {
    const { key, site } = await withPricing();
    const signup = await (await breakdown(key, `?site=${site.id}&dimension=event&value=signup&days=1`)).json();
    expect(signup.days).toEqual([{ date: "2026-11-05", count: 1, visitors: 1 }]);
    const other = await (await breakdown(key, `?site=${site.id}&dimension=event&value=/pricing&days=1`)).json();
    expect(other.days).toEqual([{ date: "2026-11-05", count: 0, visitors: 0 }]);
  });

  it("finds nothing of another workspace's site", async () => {
    const mine = await withPricing("Mine");
    const theirs = await withPricing("Theirs");
    expect((await breakdown(mine.key, `?site=${theirs.site.id}&dimension=page&value=/pricing`)).status).toBe(404);
  });

  it("refuses no key, a site that isn't an id, another dimension, and no value", async () => {
    const { key, site } = await seat();
    expect((await breakdown(null, `?site=${site.id}&dimension=page&value=/`)).status).toBe(401);
    expect((await breakdown(key, "?site=nonsense&dimension=page&value=/")).status).toBe(400);
    expect((await breakdown(key, "?dimension=page&value=/")).status).toBe(400);
    expect((await breakdown(key, `?site=${site.id}&dimension=country&value=FR`)).status).toBe(400);
    expect((await breakdown(key, `?site=${site.id}&dimension=page`)).status).toBe(400);
  });
});
