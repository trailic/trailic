import { beforeAll, describe, expect, it } from "vitest";
import { collectorDirectory, createSite, deleteSite, isUuid, rotateSiteKey, siteIn, sitesOf, updateSite } from "@/application/sites";
import { boundedDays, periodEndingAt } from "@/application/time-range";
import { hostAllowed, hostOf, parseDomains, validRetention } from "@/domain/sites";
import { coarseClient, isBot } from "@/domain/user-agent";
import { RateWindow } from "@/domain/rate-window";
import { dayOf, happenedAt, pathAndCampaign, referrerHost } from "@/domain/collected";
import { siteIdOfKey } from "@/infrastructure/crypto/site-key";
import type { Database } from "@/infrastructure/db/client";
import { member } from "@/infrastructure/db/schema/tenancy";
import { NOW, SECRET } from "./support/analytics";
import { createTestDatabase, createTestWorkspace } from "./support/database";

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
});

const INPUT = { name: "Acme shop", domains: "shop.acme.example" };

describe("a site", () => {
  it("gets a key that says which site it is", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await createSite(db, SECRET, workspaceId, userId, INPUT);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(siteIdOfKey(made.key, SECRET)).toBe(made.id);
    expect(await siteIn(db, workspaceId, made.id)).toMatchObject({ name: "Acme shop", allowedDomains: ["shop.acme.example"], retentionDays: 90, publicKey: made.key, lastWrittenAt: null });
  });

  it("wants a name and a real domain, and only one by that name", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    expect(await createSite(db, SECRET, workspaceId, userId, { name: "  ", domains: "a.example" })).toMatchObject({ ok: false, error: expect.stringContaining("name") });
    expect(await createSite(db, SECRET, workspaceId, userId, { name: "A", domains: "   " })).toMatchObject({ ok: false, error: expect.stringContaining("domain") });
    expect(await createSite(db, SECRET, workspaceId, userId, { name: "A", domains: "not a domain!" })).toMatchObject({ ok: false, error: expect.stringContaining("isn’t a domain") });
    expect((await createSite(db, SECRET, workspaceId, userId, INPUT)).ok).toBe(true);
    expect(await createSite(db, SECRET, workspaceId, userId, INPUT)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  });

  it("is run by owners and admins, not members", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    const { userId: mate } = await createTestWorkspace(db, "Mate's own");
    await db.insert(member).values({ workspaceId, userId: mate, role: "member" });
    expect((await createSite(db, SECRET, workspaceId, mate, INPUT)).ok).toBe(false);
    expect((await updateSite(db, workspaceId, mate, crypto.randomUUID(), { name: "x" })).ok).toBe(false);
    expect((await rotateSiteKey(db, SECRET, workspaceId, mate, crypto.randomUUID())).ok).toBe(false);
    expect((await deleteSite(db, workspaceId, mate, crypto.randomUUID())).ok).toBe(false);
  });

  it("changes its domains and retention, within limits", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await createSite(db, SECRET, workspaceId, userId, INPUT);
    if (!made.ok) throw new Error(made.error);
    expect((await updateSite(db, workspaceId, userId, made.id, { name: "New", domains: "https://a.example, b.example/path", retentionDays: "120" })).ok).toBe(true);
    expect(await siteIn(db, workspaceId, made.id)).toMatchObject({ name: "New", allowedDomains: ["a.example", "b.example"], retentionDays: 120 });
    expect((await updateSite(db, workspaceId, userId, made.id, { retentionDays: 3 })).ok).toBe(false);
    expect((await updateSite(db, workspaceId, userId, made.id, { domains: "" })).ok).toBe(false);
    expect((await updateSite(db, workspaceId, userId, crypto.randomUUID(), { name: "Gone" })).ok).toBe(false);
  });

  it("gets a new key that ends the old one", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await createSite(db, SECRET, workspaceId, userId, INPUT);
    if (!made.ok) throw new Error(made.error);
    expect((await rotateSiteKey(db, SECRET, workspaceId, userId, made.id)).ok).toBe(true);
    const site = await siteIn(db, workspaceId, made.id);
    expect(site?.publicKey).not.toBe(made.key);
    expect(siteIdOfKey(site?.publicKey, SECRET)).toBe(made.id);
    expect((await rotateSiteKey(db, SECRET, workspaceId, userId, crypto.randomUUID())).ok).toBe(false);
  });

  it("stays in its workspace", async () => {
    const mine = await createTestWorkspace(db, "Mine");
    const theirs = await createTestWorkspace(db, "Theirs");
    const made = await createSite(db, SECRET, theirs.workspaceId, theirs.userId, INPUT);
    if (!made.ok) throw new Error(made.error);
    expect(await siteIn(db, mine.workspaceId, made.id)).toBeUndefined();
    expect(await sitesOf(db, mine.workspaceId)).toEqual([]);
    expect((await updateSite(db, mine.workspaceId, mine.userId, made.id, { name: "Stolen" })).ok).toBe(false);
    expect((await deleteSite(db, mine.workspaceId, mine.userId, made.id)).ok).toBe(false);
    expect((await rotateSiteKey(db, SECRET, mine.workspaceId, mine.userId, made.id)).ok).toBe(false);
    expect(await siteIn(db, theirs.workspaceId, made.id)).toMatchObject({ name: "Acme shop" });
  });

  it("is in the collector's directory until it's deleted", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await createSite(db, SECRET, workspaceId, userId, INPUT);
    if (!made.ok) throw new Error(made.error);
    expect(await collectorDirectory(db)).toContainEqual({ siteId: made.id, key: made.key, allowedDomains: ["shop.acme.example"], anonymous: true });
    await deleteSite(db, workspaceId, userId, made.id);
    expect((await collectorDirectory(db)).map(({ siteId }) => siteId)).not.toContain(made.id);
  });

  it("starts in anonymous mode, which whoever manages settings can turn off and on, and the collector hears of it", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await createSite(db, SECRET, workspaceId, userId, INPUT);
    if (!made.ok) throw new Error(made.error);
    expect((await siteIn(db, workspaceId, made.id))?.anonymous).toBe(true);
    expect(await updateSite(db, workspaceId, userId, made.id, { anonymous: false })).toMatchObject({ ok: true });
    expect((await siteIn(db, workspaceId, made.id))?.anonymous).toBe(false);
    expect((await collectorDirectory(db)).find(({ siteId }) => siteId === made.id)?.anonymous).toBe(false);
    expect(await updateSite(db, workspaceId, userId, made.id, { name: "Renamed" })).toMatchObject({ ok: true });
    expect((await siteIn(db, workspaceId, made.id))?.anonymous).toBe(false);
    expect(await updateSite(db, workspaceId, userId, made.id, { anonymous: true })).toMatchObject({ ok: true });
    expect((await siteIn(db, workspaceId, made.id))?.anonymous).toBe(true);
  });

  it("doesn't take a bad id to the database", async () => {
    const { workspaceId } = await createTestWorkspace(db);
    expect(isUuid("nonsense")).toBe(false);
    expect(await siteIn(db, workspaceId, "nonsense")).toBeUndefined();
  });
});

describe("domains", () => {
  it("come in whatever form people type them", () => {
    expect(hostOf("https://www.Acme.example:3000/path?q=1")).toBe("www.acme.example");
    expect(hostOf("acme.example")).toBe("acme.example");
    expect(hostOf("localhost")).toBe("localhost");
    expect(hostOf("http://localhost:4100")).toBe("localhost");
    for (const bad of ["", null, undefined, "not a domain", "https://", "exa mple.com"]) expect(hostOf(bad)).toBeNull();
    expect(parseDomains("a.example, https://b.example/x\nc.example a.example")).toEqual({ domains: ["a.example", "b.example", "c.example"], invalid: [] });
    expect(parseDomains("a.example ???")).toEqual({ domains: ["a.example"], invalid: ["???"] });
  });

  it("allow themselves and what's under them, and nothing that only looks like them", () => {
    expect(hostAllowed("acme.example", ["acme.example"])).toBe(true);
    expect(hostAllowed("shop.acme.example", ["acme.example"])).toBe(true);
    expect(hostAllowed("notacme.example", ["acme.example"])).toBe(false);
    expect(hostAllowed("acme.example.evil.example", ["acme.example"])).toBe(false);
    expect(hostAllowed("acme.example", ["shop.acme.example"])).toBe(false);
  });

  it("keep raw events between 14 days and two years", () => {
    expect(validRetention(90)).toBe(90);
    expect(validRetention("14")).toBe(14);
    expect(validRetention(730)).toBe(730);
    for (const bad of [13, 731, 1.5, "abc", null]) expect(validRetention(bad)).toBeNull();
  });
});

describe("a user agent", () => {
  const AGENTS: [string, ReturnType<typeof coarseClient>][] = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", { device: "desktop", browser: "Chrome", os: "macOS" }],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", { device: "desktop", browser: "Safari", os: "macOS" }],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", { device: "mobile", browser: "Safari", os: "iOS" }],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", { device: "tablet", browser: "Safari", os: "iOS" }],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", { device: "mobile", browser: "Chrome", os: "Android" }],
    ["Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", { device: "tablet", browser: "Chrome", os: "Android" }],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0", { device: "desktop", browser: "Edge", os: "Windows" }],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", { device: "desktop", browser: "Firefox", os: "Linux" }],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0", { device: "desktop", browser: "Opera", os: "Windows" }],
    ["Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", { device: "mobile", browser: "Samsung Internet", os: "Android" }],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", { device: "desktop", browser: "Chrome", os: "ChromeOS" }],
    ["Something nobody has heard of", { device: "desktop", browser: "Other", os: "Other" }],
  ];

  it.each(AGENTS)("%s", (agent, client) => {
    expect(coarseClient(agent)).toEqual(client);
    expect(isBot(agent)).toBe(false);
  });

  it("is a bot when it says so, or says nothing", () => {
    expect(isBot("Mozilla/5.0 (Linux; Android 11; CUBOT X50) Chrome/140 Mobile Safari/537.36")).toBe(false);
    for (const bot of ["Googlebot/2.1", "Mozilla/5.0 (compatible; AhrefsBot/7.0)", "facebookexternalhit/1.1", "Mozilla/5.0 HeadlessChrome/140", "curl/8.4", "Playwright/1.50", null, ""]) expect(isBot(bot), String(bot)).toBe(true);
  });
});

describe("small rules", () => {
  it("a window of counts forgets the last minute", () => {
    const window = new RateWindow(2);
    expect(window.take("a", 0)).toBe(true);
    expect(window.take("a", 1)).toBe(true);
    expect(window.take("a", 2)).toBe(false);
    expect(window.take("b", 3)).toBe(true);
    expect(window.take("a", 60_000)).toBe(true);
  });

  it("a period is whole days, ending today, in UTC", () => {
    expect(periodEndingAt(NOW, 2)).toMatchObject({ from: "2026-11-04", to: "2026-11-05", days: ["2026-11-04", "2026-11-05"], start: "2026-11-04T00:00:00.000Z", end: "2026-11-06T00:00:00.000Z" });
    expect(boundedDays("7")).toBe(7);
    expect(boundedDays("x")).toBe(30);
    expect(boundedDays(0)).toBe(30);
    expect(boundedDays(-5)).toBe(1);
    expect(boundedDays(99_999)).toBe(365);
    expect(dayOf(new Date("2026-11-05T23:59:59Z"))).toBe("2026-11-05");
  });

  it("an address gives up its path and campaign, tolerating odd ones", () => {
    expect(pathAndCampaign(undefined)).toMatchObject({ path: null, utmSource: null });
    expect(pathAndCampaign("/a?utm_source=caf%C3%A9+news&utm_source2=x")).toMatchObject({ path: "/a", utmSource: "café news" });
    expect(pathAndCampaign("/a?utm_source=%E0%A4%A")).toMatchObject({ utmSource: "%E0%A4%A" });
    expect(pathAndCampaign(`/${"x".repeat(600)}`).path).toHaveLength(512);
    expect(pathAndCampaign("/?UTM_SOURCE=news")).toMatchObject({ path: "/", utmSource: "news" });
  });

  it("a referrer's host is dropped when it's the site, with or without www", () => {
    expect(referrerHost(undefined, "a.example")).toBeNull();
    expect(referrerHost("https://www.a.example/x", "a.example")).toBeNull();
    expect(referrerHost("https://a.example/x", "www.a.example")).toBeNull();
    expect(referrerHost("https://b.example/x?y=1", "a.example")).toBe("b.example");
  });

  it("a moment comes from the server's clock, less what was waited", () => {
    expect(happenedAt(NOW, undefined)).toBe(NOW.toISOString());
    expect(happenedAt(NOW, 1_000)).toBe(new Date(NOW.getTime() - 1_000).toISOString());
  });
});
