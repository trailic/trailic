import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { answerInFull } from "@/app/mcp/answer-in-full";
import { POST } from "@/app/mcp/route";
import type { Services } from "@/application/services";
import { removeMember } from "@/application/team";
import { startWorkspace } from "@/application/workspaces";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { member } from "@/infrastructure/db/schema/tenancy";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { addSite } from "./support/analytics";
import { fakeFetch } from "./support/fetch";

const token = vi.hoisted(() => ({ userId: "" as string | null }));
const shared = vi.hoisted(() => ({ services: undefined as unknown, settings: { BETTER_AUTH_URL: "https://trailic.test" } }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/auth/server", () => ({
  memberOfToken: async () => {
    if (!token.userId) throw new Error("No token");
    return { userId: token.userId, clientId: "assistant" };
  },
}));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => (shared.services as Services).db }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => shared.settings }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => shared.services }));
vi.mock("@/app/mcp/answer-in-full", async (original) => {
  const real = await original<typeof import("@/app/mcp/answer-in-full")>();
  return { answerInFull: vi.fn(real.answerInFull) };
});

const settings = { TRAILIC_ADMINS: "founder@example.com", BETTER_AUTH_URL: "https://trailic.test", BETTER_AUTH_SECRET: "a-long-enough-secret-for-signing-tests-only" } as Env;

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => new Date("2026-11-05T09:00:00Z") };
  shared.services = services;
});
beforeEach(() => {
  token.userId = null;
  settings.TRAILIC_ADMINS = "founder@example.com";
});

/** Speaks to /mcp over HTTP, as an assistant does: the real route, with only the token's signature assumed. */
async function send(message: unknown) {
  const response = await POST(
    new Request("https://trailic.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify(message),
    }),
  );
  const text = await response.text();
  if (text.startsWith("{")) return { status: response.status, body: JSON.parse(text), text };
  const replies = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  return { status: response.status, body: Array.isArray(message) ? replies : (replies[0] ?? null), text };
}

const rpc = async (method: string, params: Record<string, unknown> = {}) => (await send({ jsonrpc: "2.0", id: 1, method, params })).body.result;
const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
const siteNames = (result: { structuredContent: { sites: { name: string }[] } }) => result.structuredContent.sites.map(({ name }) => name);

/** A member with two workspaces, each with its own site, and a stranger's with its own. */
async function memberOfTwo() {
  const { workspaceId: acme, userId } = await createTestWorkspace(db, "Acme");
  const northwind = (await startWorkspace(db, settings, { userId, email: "founder@example.com" }, "Northwind")) as string;
  const stranger = await createTestWorkspace(db, "Secret Corp");
  await addSite(db, acme, userId, "Acme’s site");
  await addSite(db, northwind, userId, "Northwind’s site");
  await addSite(db, stranger.workspaceId, stranger.userId, "Secret site");
  token.userId = userId;
  return { acme, northwind, userId, stranger: stranger.workspaceId };
}

const refusedWithNames = (result: { isError?: boolean; content: { text: string }[] }) => {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('"Acme"');
  expect(result.content[0].text).toContain('"Northwind"');
};

describe("an assistant, for a member with several workspaces", () => {
  it("answers the protocol's own methods without asking which workspace", async () => {
    await memberOfTwo();
    const started = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(started.serverInfo.name).toBe("trailic");
    expect(started.instructions).toContain("several companies");
    expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(await rpc("ping")).toEqual({});
  });

  it("offers an optional workspace argument on every tool but list_workspaces, saying what it's for", async () => {
    await memberOfTwo();
    const { tools } = await rpc("tools/list");
    for (const { name, inputSchema } of tools) {
      if (name === "list_workspaces") {
        expect(inputSchema.properties ?? {}).not.toHaveProperty("workspace");
        continue;
      }
      expect(inputSchema.properties.workspace, name).toMatchObject({ type: "string", description: expect.stringContaining("exact name") });
      expect(inputSchema.required ?? []).not.toContain("workspace");
    }
  });

  it("lists their workspaces with their role, read-only", async () => {
    const { acme, northwind } = await memberOfTwo();
    const { tools } = await rpc("tools/list");
    expect(tools.find(({ name }: { name: string }) => name === "list_workspaces").annotations.readOnlyHint).toBe(true);
    const { structuredContent } = await tool("list_workspaces");
    expect(structuredContent.workspaces).toEqual([
      { id: acme, name: "Acme", role: "owner" },
      { id: northwind, name: "Northwind", role: "owner" },
    ]);
  });

  it("refuses a call that names no workspace, listing theirs so the assistant asks", async () => {
    await memberOfTwo();
    refusedWithNames(await tool("list_sites"));
  });

  it("works in the workspace named, by name or by id, and sees only that one's", async () => {
    const { acme, northwind } = await memberOfTwo();
    expect(siteNames(await tool("list_sites", { workspace: "Acme" }))).toEqual(["Acme’s site"]);
    expect(siteNames(await tool("list_sites", { workspace: "Northwind" }))).toEqual(["Northwind’s site"]);
    expect(siteNames(await tool("list_sites", { workspace: acme }))).toEqual(["Acme’s site"]);
    expect(siteNames(await tool("list_sites", { workspace: northwind }))).toEqual(["Northwind’s site"]);
  });

  it("gives the same refusal for a workspace that doesn't exist and one that isn't theirs, by name or id", async () => {
    const { stranger } = await memberOfTwo();
    const without = await tool("list_sites");
    for (const named of ["Secret Corp", stranger, "Nobody's", "acme", "33333333-3333-4333-8333-333333333333"]) {
      const refused = await tool("list_sites", { workspace: named });
      expect(refused).toEqual(without);
      expect(JSON.stringify(refused)).not.toContain("Secret");
    }
  });

  it("serves each call of a batch in its own workspace", async () => {
    await memberOfTwo();
    const call = (id: number, workspace?: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_sites", arguments: workspace ? { workspace } : {} } });
    const { body } = await send([call(1, "Acme"), call(2, "Northwind"), call(3)]);
    const byId = Object.fromEntries(body.map((reply: { id: number; result: unknown }) => [reply.id, reply.result]));
    expect(siteNames(byId[1])).toEqual(["Acme’s site"]);
    expect(siteNames(byId[2])).toEqual(["Northwind’s site"]);
    refusedWithNames(byId[3]);
  });

  it("still validates a tool's own arguments", async () => {
    await memberOfTwo();
    const refused = await tool("top_pages", { workspace: "Acme" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("Invalid arguments");
  });

  it("links a site through the workspace it was asked about, since the screens use the browser's", async () => {
    const { northwind } = await memberOfTwo();
    const { structuredContent } = await tool("list_sites", { workspace: "Northwind" });
    const { id, url } = structuredContent.sites[0];
    expect(url).toBe(`https://trailic.test/workspace/${northwind}?${new URLSearchParams({ next: `/overview?site=${id}` })}`);
  });

  it("offers nothing that invites, removes or changes members", async () => {
    await memberOfTwo();
    const { tools } = await rpc("tools/list");
    for (const { name } of tools) expect(name).not.toMatch(/invit|member|team|role/i);
    expect(tools.map(({ name }: { name: string }) => name).filter((name: string) => /workspace/.test(name))).toEqual(["list_workspaces"]);
  });

  it("forgets a workspace at once when they're taken out of it, even on the same token", async () => {
    const { acme, northwind, userId } = await memberOfTwo();
    expect(siteNames(await tool("list_sites", { workspace: "Northwind" }))).toEqual(["Northwind’s site"]);
    await db.delete(member).where(and(eq(member.workspaceId, northwind), eq(member.userId, userId)));
    const refused = await tool("list_sites", { workspace: "Northwind" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('"Acme"');
    expect(refused.content[0].text).not.toContain("Northwind");
    expect((await tool("list_workspaces")).structuredContent.workspaces).toEqual([{ id: acme, name: "Acme", role: "owner" }]);
  });
});

describe("an assistant, for a member with one workspace", () => {
  async function memberOfOne() {
    const { workspaceId, userId } = await createTestWorkspace(db, "Solo");
    await addSite(db, workspaceId, userId, "Solo’s site");
    token.userId = userId;
    return { workspaceId, userId };
  }

  it("sees no workspace argument anywhere, and no word about several", async () => {
    await memberOfOne();
    const { tools } = await rpc("tools/list");
    expect(tools).toHaveLength(8);
    for (const { name, inputSchema } of tools) expect(inputSchema.properties ?? {}, name).not.toHaveProperty("workspace");
    expect(JSON.stringify(tools)).not.toContain("exact name");
    const started = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(started.instructions).not.toContain("several companies");
  });

  it("works with no argument to give", async () => {
    await memberOfOne();
    expect(siteNames(await tool("list_sites"))).toEqual(["Solo’s site"]);
  });

  it("links a site directly", async () => {
    await memberOfOne();
    const { id, url } = (await tool("list_sites")).structuredContent.sites[0];
    expect(url).toBe(`https://trailic.test/overview?site=${id}`);
  });

  it("still lists their workspace", async () => {
    const { workspaceId } = await memberOfOne();
    expect((await tool("list_workspaces")).structuredContent.workspaces).toEqual([{ id: workspaceId, name: "Solo", role: "owner" }]);
  });

  it("accepts its own workspace named, but refuses another rather than quietly using theirs", async () => {
    const { workspaceId } = await memberOfOne();
    expect(siteNames(await tool("list_sites", { workspace: "Solo" }))).toEqual(["Solo’s site"]);
    expect(siteNames(await tool("list_sites", { workspace: workspaceId }))).toEqual(["Solo’s site"]);
    const refused = await tool("list_sites", { workspace: "The one they left" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('"Solo"');
  });
});

const toolNames = async () => ((await rpc("tools/list")).tools as { name: string }[]).map(({ name }) => name);

/** Someone this instance lets start workspaces, signed in, with none yet. */
async function admin() {
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  await db.insert(user).values({ id, name: "Ada", email });
  settings.TRAILIC_ADMINS = email;
  token.userId = id;
  return id;
}

describe("starting a workspace", () => {
  it("is all an admin with none yet is offered, and the rest arrives with it", async () => {
    await admin();
    expect((await toolNames()).sort()).toEqual(["create_workspace", "list_workspaces"]);
    const { structuredContent } = await tool("create_workspace", { name: "  Shop Co  " });
    expect(structuredContent.workspace).toMatchObject({ name: "Shop Co", role: "owner" });
    expect(await toolNames()).toContain("create_site");
    expect((await tool("list_workspaces")).structuredContent.workspaces).toMatchObject([{ id: structuredContent.workspace.id, name: "Shop Co", role: "owner" }]);
  });

  it("refuses a name they already have, which no call could then tell apart", async () => {
    await admin();
    await tool("create_workspace", { name: "Shop Co" });
    expect(await tool("create_workspace", { name: " Shop Co " })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("already has a workspace") }] });
    expect((await tool("list_workspaces")).structuredContent.workspaces).toHaveLength(1);
  });

  it("isn't offered to a member who isn't an admin, nor runs for them", async () => {
    const { userId } = await createTestWorkspace(db, "Team");
    token.userId = userId;
    expect(await toolNames()).not.toContain("create_workspace");
    const { body } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_workspace", arguments: { name: "Mine" } } });
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect((await tool("list_workspaces")).structuredContent.workspaces).toHaveLength(1);
  });

  it("stops being offered on the call after someone stops being an admin", async () => {
    await admin();
    expect(await toolNames()).toContain("create_workspace");
    settings.TRAILIC_ADMINS = "someone-else@example.test";
    expect((await send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).status).toBe(403);
  });
});

describe("/mcp at its door", () => {
  it("answers 401 without a token, pointing at how to sign in", async () => {
    const { status, body } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("keeps its 403 for someone with no workspace, even for list_workspaces", async () => {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Bea", email: `${id}@example.test` });
    token.userId = id;
    const { status, body } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_workspaces", arguments: {} } });
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: "no_workspace", error_description: expect.stringContaining("https://trailic.test/welcome") });
  });

  it("gives that 403 to someone removed from their only workspace, on their next call", async () => {
    const { workspaceId, userId: ownerId } = await createTestWorkspace(db, "Team");
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Bea", email: `${id}@example.test` });
    await db.insert(member).values({ workspaceId, userId: id, role: "member" });
    token.userId = id;
    expect((await tool("list_sites")).structuredContent.sites).toEqual([]);
    await removeMember(db, workspaceId, ownerId, id);
    expect((await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sites", arguments: {} } })).status).toBe(403);
  });

  it("keeps reading a tool's answer to its end before returning, refusals included", async () => {
    await memberOfTwo();
    vi.mocked(answerInFull).mockClear();
    const { text } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sites", arguments: { workspace: "Acme" } } });
    expect(text).toContain("Acme’s site");
    await tool("list_sites");
    expect(answerInFull).toHaveBeenCalledTimes(2);
  });
});
