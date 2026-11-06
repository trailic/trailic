import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { importHistory } from "@/application/history";
import { createApiKey } from "@/application/api-keys";
import { createFunnel } from "@/application/funnels";
import { flushBuffer } from "@/application/flush";
import { erasePerson } from "@/application/people";
import { inviteToWorkspace } from "@/application/invitations";
import type { Services } from "@/application/services";
import type { Database } from "@/infrastructure/db/client";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { addSite, batchOf, collected, memoryBuffer, NOW, visitor } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";

/**
 * Isolation is checked against the database itself, not a list kept by hand: a new table that isn't
 * in `TRUSTED_TABLES` and lacks row-level security, a policy, a grant or its rows here fails this file.
 * That includes each month's partition of raw events, made at runtime: read directly, a partition
 * doesn't go through its parent's policies, so each needs its own.
 */

/** Read before any workspace is known, or owned by Better Auth. Everything else belongs to a workspace. */
const TRUSTED_TABLES = ["account", "jwks", "member", "oauth_access_token", "oauth_client", "oauth_client_assertion", "oauth_client_resource", "oauth_consent", "oauth_refresh_token", "oauth_resource", "rate_limit", "session", "user", "verification", "workspace"];

/** Two months, so more than one partition is checked. Both within what a site keeps. */
const MONTHS = ["2026-10-20T10:00:00.000Z", "2026-11-05T08:00:00.000Z"];

let db: Database;
let tables: string[];
let mine: Awaited<ReturnType<typeof createTestWorkspace>>;
let theirs: Awaited<ReturnType<typeof createTestWorkspace>>;

const rowsOf = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;
const query = async (statement: ReturnType<typeof sql>, on: Database = db) => rowsOf(await on.execute(statement));

/** One workspace's rows in every table it can have them. */
async function stock(workspaceId: string, userId: string) {
  const site = await addSite(db, workspaceId, userId);
  const services = { db, settings: { BETTER_AUTH_URL: "https://trailic.test" } as Env, fetch: fakeFetch([]).fetch, now: () => NOW } satisfies Services;
  const made = await createApiKey(db, workspaceId, userId, "Key", ["figures:read"]);
  if (!made.ok) throw new Error(made.error);
  await inviteToWorkspace(services, workspaceId, userId, "new@customer.example", "member");
  await createFunnel(db, workspaceId, { siteId: site.id, name: "Sign-up", steps: [{ kind: "page", match: "/" }, { kind: "event", match: "signup" }] });
  const buffer = memoryBuffer();
  await buffer.append(batchOf(site, MONTHS.flatMap((at) => [collected({ at, userId: "user_1" }), collected({ at, kind: "event", name: "signup" }), collected({ at, kind: "vital", name: "LCP", value: 1 }), collected({ at, kind: "identify", userId: "user_2", visitor: visitor(9) })])));
  await flushBuffer({ db, buffer, now: () => NOW });
  await erasePerson(db, workspaceId, userId, site.id, "user_2", NOW);
  await importHistory(db, workspaceId, { siteId: site.id, source: "Another tool", counts: "all page views it recorded", days: [{ day: "2026-01-15", visitors: 1, pageViews: 1, events: 0, bounces: 1, dimensions: {} }] }, NOW);
}

beforeAll(async () => {
  db = await createTestDatabase();
  mine = await createTestWorkspace(db, "Mine");
  theirs = await createTestWorkspace(db, "Theirs");
  await stock(mine.workspaceId, mine.userId);
  await stock(theirs.workspaceId, theirs.userId);
  const found = await query(sql`select tablename from pg_tables where schemaname = 'public' order by 1`);
  tables = found.map(({ tablename }) => tablename as string).filter((name) => !TRUSTED_TABLES.includes(name));
});

describe("every table that belongs to a workspace", () => {
  it("is found: this file can't pass by looking at nothing", () => {
    expect(tables).toEqual(expect.arrayContaining(["api_key", "daily_dimension", "daily_site", "daily_vital", "erased_person", "event", "event_2026_10", "event_2026_11", "flushed_batch", "funnel", "history_import", "invitation", "person", "site"]));
  });

  it("has row-level security on, and the tenant policy", async () => {
    for (const table of tables) {
      const [state] = await query(sql`select relrowsecurity from pg_class where oid = ${`public.${table}`}::regclass`);
      expect(state.relrowsecurity, `${table} has no row-level security`).toBe(true);
      const policies = await query(sql`select qual, with_check, roles::text as roles from pg_policies where schemaname = 'public' and tablename = ${table}`);
      expect(policies, `${table} has no policy`).toHaveLength(1);
      expect(policies[0].qual, table).toContain("app_workspace_id()");
      expect(policies[0].with_check, table).toContain("app_workspace_id()");
      expect(policies[0].roles, table).toContain("tenant_app");
    }
  });

  it("carries the workspace it belongs to", async () => {
    for (const table of tables) {
      const columns = await query(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = 'workspace_id'`);
      expect(columns, `${table} has no workspace_id`).toHaveLength(1);
    }
  });

  it("shows a workspace its own rows and nobody else's", async () => {
    for (const table of tables) {
      const name = sql.identifier(table);
      for (const [here, there] of [[mine.workspaceId, theirs.workspaceId], [theirs.workspaceId, mine.workspaceId]]) {
        const seen = await withWorkspace(db, here, (tx) => query(sql`select workspace_id from ${name}`, tx));
        expect(seen.length, `${table} has no rows to test with: stock it above`).toBeGreaterThan(0);
        expect(seen.every(({ workspace_id }) => workspace_id === here), `${table} shows another workspace's rows`).toBe(true);
        const [{ count }] = await withWorkspace(db, here, (tx) => query(sql`select count(*)::int as count from ${name} where workspace_id = ${there}`, tx));
        expect(count, `${table} answers about another workspace`).toBe(0);
      }
    }
  });

  it("won't update or delete another workspace's rows", async () => {
    for (const table of tables) {
      const name = sql.identifier(table);
      const [before] = await query(sql`select count(*)::int as count from ${name} where workspace_id = ${theirs.workspaceId}`);
      const deleted = await withWorkspace(db, mine.workspaceId, (tx) => query(sql`delete from ${name} where workspace_id = ${theirs.workspaceId} returning 1`, tx));
      expect(deleted, table).toEqual([]);
      const [after] = await query(sql`select count(*)::int as count from ${name} where workspace_id = ${theirs.workspaceId}`);
      expect(after.count, `${table} lost rows to another workspace`).toBe(before.count);
    }
  });

  it("won't take a row written into another workspace", async () => {
    const [theirSite] = await query(sql`select id from site where workspace_id = ${theirs.workspaceId}`);
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`insert into funnel (workspace_id, site_id, name, steps, window_hours) values (${theirs.workspaceId}, ${theirSite.id}, 'Planted', '[]', 1)`))).rejects.toThrow();
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`update funnel set workspace_id = ${theirs.workspaceId} where name = 'Sign-up'`))).rejects.toThrow();
    for (const table of ["event", "event_2026_11"]) {
      await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`insert into ${sql.identifier(table)} (workspace_id, site_id, at, kind) values (${theirs.workspaceId}, ${theirSite.id}, '2026-11-05T00:00:00Z', 'page')`)), table).rejects.toThrow();
    }
  });

  it("shows nothing at all with no workspace set, even as the app role", async () => {
    for (const table of tables) {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('role', 'tenant_app', true)`);
        return query(sql`select 1 from ${sql.identifier(table)}`, tx);
      });
      expect(rows, table).toEqual([]);
    }
  });
});

describe("what stays with the trusted path", () => {
  it("can't be written by the app role: memberships, workspaces and identity", async () => {
    for (const statement of [sql`insert into member (workspace_id, user_id, role) values (${mine.workspaceId}, ${theirs.userId}, 'owner')`, sql`update workspace set name = 'Stolen'`, sql`update "user" set email = 'x@y.example'`]) {
      await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(statement))).rejects.toThrow();
    }
  });

  it("can't be read by the app role when it's identity or an assistant's tokens", async () => {
    for (const table of ["user", "session", "account", "oauth_access_token", "oauth_client", "jwks"]) {
      await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`select 1 from ${sql.identifier(table)}`)), table).rejects.toThrow();
    }
  });

  it("can't make or drop a month of events", async () => {
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`select ensure_event_partition('2031-01-01'::date)`))).rejects.toThrow();
    await expect(withWorkspace(db, mine.workspaceId, (tx) => tx.execute(sql`drop table event_2026_11`))).rejects.toThrow();
  });

  it("is a list that only names tables that exist, so it can't hide a mistake", async () => {
    const existing = (await query(sql`select tablename from pg_tables where schemaname = 'public'`)).map(({ tablename }) => tablename);
    for (const table of TRUSTED_TABLES) expect(existing, `${table} no longer exists: take it off the list`).toContain(table);
  });
});
