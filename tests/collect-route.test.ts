import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPTIONS, POST } from "@/app/api/e/route";
import { REQUESTS_PER_SENDER_MINUTE } from "@/application/collect";
import type { DirectoryEntry } from "@/application/sites";
import type { BufferedBatch } from "@/domain/collected";
import { LARGEST_BODY_BYTES } from "@/domain/collected";
import { mintSiteKey } from "@/infrastructure/crypto/site-key";
import { memoryBuffer, SECRET } from "./support/analytics";

const SITE_ID = "11111111-2222-4333-8444-555555555555";
const KEY = mintSiteKey(SITE_ID, SECRET);

const shared = vi.hoisted(() => ({ buffer: undefined as unknown, secret: undefined as string | undefined, directory: [] as unknown }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => ({ TRAILIC_SECRET: shared.secret }) }));
vi.mock("@/infrastructure/buffer", () => ({ eventBuffer: () => shared.buffer }));
vi.mock("@/infrastructure/collector/directory", () => ({ directoryForCollector: async () => shared.directory }));
// The collector must not reach for the database at all: this makes it fail loudly if it does.
vi.mock("@/infrastructure/db/client", () => ({ db: () => { throw new Error("The collector touched the database."); } }));

const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ key: KEY, events: [{ kind: "page", path: "/" }], ...extra });

function post(text: string, headers: Record<string, string> = {}) {
  return POST(new Request("https://trailic.test/api/e", { method: "POST", body: text, headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://acme.example", "user-agent": FIREFOX, "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-vercel-ip-country": "FR", ...headers } }));
}

const kept = () => (shared.buffer as ReturnType<typeof memoryBuffer>).waiting.map(({ batch }) => batch as BufferedBatch);

beforeEach(() => {
  shared.buffer = memoryBuffer();
  shared.secret = SECRET;
  shared.directory = [{ siteId: SITE_ID, key: KEY, allowedDomains: ["acme.example"], anonymous: false }] satisfies DirectoryEntry[];
});

describe("POST /api/e", () => {
  it("takes plain text from an allowed page, says the page may read that, and sets no cookie", async () => {
    const answer = await post(body());
    expect(answer.status).toBe(202);
    expect(answer.headers.get("access-control-allow-origin")).toBe("https://acme.example");
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(kept()[0].events[0]).toMatchObject({ path: "/", country: "FR" });
  });

  it("reads the visitor from the first address a proxy names, and stores none of them", async () => {
    await post(body());
    await post(body(), { "x-forwarded-for": "203.0.113.7" });
    await post(body(), { "x-forwarded-for": "203.0.113.8" });
    const [first, second, third] = kept().map(({ events }) => events[0].visitor);
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(JSON.stringify(kept())).not.toContain("203.0.113");
  });

  it("falls back on X-Real-IP", async () => {
    const answer = await POST(new Request("https://trailic.test/api/e", { method: "POST", body: body(), headers: { origin: "https://acme.example", "user-agent": FIREFOX, "x-real-ip": "203.0.113.7" } }));
    expect(answer.status).toBe(202);
  });

  it("gives another domain no way to read the answer", async () => {
    const answer = await post(body(), { origin: "https://evil.example" });
    expect(answer.status).toBe(403);
    expect(answer.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses more than its limit, however the size is declared", async () => {
    const oversize = JSON.stringify({ key: KEY, events: [{ kind: "page", path: "/", referrer: "x".repeat(LARGEST_BODY_BYTES) }] });
    expect((await post(oversize)).status).toBe(413);
    expect((await post(oversize, { "content-length": "10" })).status).toBe(413);
  });

  it("can't work without its secret, and says so", async () => {
    shared.secret = undefined;
    expect((await post(body())).status).toBe(503);
  });

  it("doesn't count a browser fetching ahead of time", async () => {
    expect((await post(body(), { "sec-purpose": "prefetch" })).status).toBe(202);
    expect((await post(body(), { purpose: "prefetch" })).status).toBe(202);
    expect(kept()).toEqual([]);
  });

  it("takes what a relay says about its visitor, with the relay's key", async () => {
    const { relayKeyOf } = await import("@/infrastructure/crypto/site-key");
    await post(body(), { "x-trailic-relay": relayKeyOf(SITE_ID, SECRET), "x-trailic-address": "198.51.100.9", "x-trailic-country": "DE", "x-forwarded-for": "76.76.21.21", "x-vercel-ip-country": "US" });
    expect(kept()[0].events[0].country).toBe("DE");
  });

  it("says how long to wait when it's limited", async () => {
    const { RateWindow } = await import("@/domain/rate-window");
    const take = vi.spyOn(RateWindow.prototype, "take").mockReturnValue(false);
    const answer = await post(body());
    take.mockRestore();
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("60");
  });
});

describe("OPTIONS /api/e", () => {
  const preflight = (key: string | null, origin = "https://acme.example") => OPTIONS(new Request(`https://trailic.test/api/e${key ? `?key=${key}` : ""}`, { method: "OPTIONS", headers: { origin } }));

  it("lets an allowed page post JSON, naming its key in the address", async () => {
    const answer = await preflight(KEY);
    expect(answer.status).toBe(204);
    expect(answer.headers.get("access-control-allow-origin")).toBe("https://acme.example");
    expect(answer.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  it("doesn't let anyone else", async () => {
    expect((await preflight(KEY, "https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    expect((await preflight(null)).headers.get("access-control-allow-origin")).toBeNull();
    shared.secret = undefined;
    expect((await preflight(KEY)).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("a flood through the route", () => {
  const FLOODER = "198.51.100.200";

  afterEach(() => vi.useRealTimers());

  it("stops one address spreading over every site at the sender's limit, and touches neither the queue nor the database after that", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2031-01-01T00:00:00.000Z") });
    const sites = Array.from({ length: 163 }, (_, index) => {
      const siteId = `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`;
      return { siteId, key: mintSiteKey(siteId, SECRET), allowedDomains: ["acme.example"], anonymous: false };
    });
    shared.directory = sites;
    const onSite = (index: number) => post(JSON.stringify({ key: sites[index % sites.length].key, events: [{ kind: "page", path: "/" }] }), { "x-forwarded-for": FLOODER, "user-agent": `${FIREFOX} ${index}` });
    const answers = [];
    for (let index = 0; index < REQUESTS_PER_SENDER_MINUTE + 3; index += 1) answers.push(await onSite(index));
    expect(kept()).toHaveLength(REQUESTS_PER_SENDER_MINUTE);
    const refused = answers.at(-1) as Response;
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect((await post(JSON.stringify({ key: sites[0].key, events: [{ kind: "page", path: "/" }] }), { "x-forwarded-for": "198.51.100.201" })).status).toBe(202);
  });
});

describe("the library and the collector", () => {
  it("agree on what's sent", async () => {
    const { wireEventsOf } = await import("@/domain/collected");
    const events = [{ kind: "page", path: "/a?utm_source=x", referrer: "https://b.example/", ago: 10 }, { kind: "event", name: "n", path: "/a", props: { a: 1, b: "two", c: true }, userId: "u" }, { kind: "identify", path: "/a", userId: "u", traits: { plan: "pro" } }, { kind: "vital", name: "LCP", value: 12.5, path: "/a" }];
    expect(wireEventsOf(events)).toHaveLength(events.length);
  });
});
