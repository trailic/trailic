import { describe, expect, it, vi } from "vitest";
import { allowedOriginFor, collect, newLimits, REQUESTS_PER_VISITOR_MINUTE, type CollectorPorts, type IncomingRequest } from "@/application/collect";
import type { DirectoryEntry } from "@/application/sites";
import { BUFFERED_BATCH, LARGEST_BODY_BYTES, MOST_EVENTS_IN_A_BATCH, type BufferedBatch } from "@/domain/collected";
import { relayKeyOf, mintSiteKey } from "@/infrastructure/crypto/site-key";
import type { WireBatch, WireEvent } from "../packages/trailic/src/wire";
import { memoryBuffer, NOW, SECRET } from "./support/analytics";

const SITE_ID = "11111111-2222-4333-8444-555555555555";
const KEY = mintSiteKey(SITE_ID, SECRET);
const DIRECTORY: DirectoryEntry[] = [{ siteId: SITE_ID, key: KEY, allowedDomains: ["acme.example"] }];
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const ADDRESS = "203.0.113.7";

function ports(overrides: Partial<CollectorPorts> = {}) {
  const buffer = memoryBuffer();
  const all: CollectorPorts = { secret: SECRET, buffer, directory: async () => DIRECTORY, limits: newLimits(), now: () => NOW, ...overrides };
  return { all, buffer, kept: () => buffer.waiting.map(({ batch }) => batch as BufferedBatch) };
}

function request(events: WireEvent[], overrides: Partial<IncomingRequest> = {}, batch: Partial<WireBatch> = {}): IncomingRequest {
  return { body: JSON.stringify({ key: KEY, events, ...batch }), origin: "https://www.acme.example", userAgent: FIREFOX, address: ADDRESS, country: "FR", prefetch: false, relay: null, ...overrides };
}

const PAGE: WireEvent = { kind: "page", path: "/pricing" };

describe("what the collector keeps", () => {
  it("takes a page view, and says only that it did", async () => {
    const { all, kept } = ports();
    const answer = await collect(all, request([PAGE]));
    expect(answer).toMatchObject({ status: 202, accepted: 1, allowOrigin: "https://www.acme.example" });
    expect(kept()).toHaveLength(1);
    expect(kept()[0]).toMatchObject({ siteId: SITE_ID, originHost: "www.acme.example", verified: true });
    expect(kept()[0].events[0]).toMatchObject({ kind: "page", path: "/pricing", at: NOW.toISOString(), country: "FR", device: "desktop", browser: "Firefox", os: "Linux" });
  });

  it("makes something the flush will believe", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE, { kind: "event", name: "signup", path: "/x", props: { plan: "pro", seats: 3, trial: true } }, { kind: "identify", userId: "user_1", traits: { plan: "pro" } }, { kind: "vital", name: "LCP", value: 1200 }]));
    expect(BUFFERED_BATCH.safeParse(kept()[0]).success).toBe(true);
    expect(kept()[0].events).toHaveLength(4);
  });

  it("gives each request its own batch id, which is what makes writing it idempotent", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE]));
    await collect(all, request([PAGE]));
    expect(kept()[0].id).not.toBe(kept()[1].id);
  });

  it("stamps events with its own clock, trusting the browser only for how long it waited, and not for long", async () => {
    const { all, kept } = ports();
    await collect(all, request([{ ...PAGE, ago: 5_000 }, { ...PAGE, ago: 999_999_999 }]));
    expect(kept()[0].events[0].at).toBe(new Date(NOW.getTime() - 5_000).toISOString());
    expect(kept()[0].events[1].at).toBe(new Date(NOW.getTime() - 3_600_000).toISOString());
  });

  it("keeps a bad event out without losing the good ones", async () => {
    const { all, kept } = ports();
    const answer = await collect(all, request([PAGE, { kind: "event" } as WireEvent, { kind: "nonsense" } as unknown as WireEvent]));
    expect(answer.accepted).toBe(1);
    expect(kept()[0].events).toHaveLength(1);
  });

  it("refuses a batch with nothing in it worth keeping", async () => {
    const { all, kept } = ports();
    expect((await collect(all, request([{ kind: "page" } as WireEvent]))).status).toBe(400);
    expect(kept()).toEqual([]);
  });
});

describe("privacy", () => {
  it("never lets the address reach the buffer, in any form it could be read back from", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE, { kind: "event", name: "x" }, { kind: "identify", userId: "u" }]));
    const stored = JSON.stringify(kept());
    expect(stored).not.toContain(ADDRESS);
    expect(stored).not.toContain("203.0.113");
  });

  it("keeps a coarse browser, never the user agent", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE]));
    expect(JSON.stringify(kept())).not.toContain("Gecko");
    expect(JSON.stringify(kept())).not.toContain("140.0");
  });

  it("counts a visitor with a salted hash, the same all day and another tomorrow", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE]));
    await collect(all, request([PAGE]));
    const tomorrow = ports({ now: () => new Date(NOW.getTime() + 86_400_000) });
    await collect(tomorrow.all, request([PAGE]));
    const [first, second] = kept();
    expect(first.events[0].visitor).toBe(second.events[0].visitor);
    expect(tomorrow.kept()[0].events[0].visitor).not.toBe(first.events[0].visitor);
  });

  it("strips the query, whatever the library sent, and keeps the campaign apart from the page", async () => {
    const { all, kept } = ports();
    await collect(all, request([{ kind: "page", path: "/welcome?token=zzsecretzz&email=zoe%40mail.example&utm_source=news&utm_medium=mail&utm_campaign=autumn&utm_term=a&utm_content=b#top" }]));
    expect(kept()[0].events[0]).toMatchObject({ path: "/welcome", utmSource: "news", utmMedium: "mail", utmCampaign: "autumn", utmTerm: "a", utmContent: "b" });
    expect(JSON.stringify(kept()[0].events)).not.toContain("zzsecretzz");
    expect(JSON.stringify(kept()[0].events)).not.toContain("zoe");
  });

  it("takes emails and long tokens out of the path", async () => {
    const { all, kept } = ports();
    await collect(all, request([{ kind: "page", path: "/users/ada@acme.example/reset/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/how-to-install-on-a-very-small-server" }]));
    expect(kept()[0].events[0].path).toBe("/users/[email]/reset/[token]/how-to-install-on-a-very-small-server");
  });

  it("reduces a referrer to its host, and drops the site itself", async () => {
    const { all, kept } = ports();
    await collect(all, request([
      { ...PAGE, referrer: "https://news.example/story?id=zoe%40mail.example" },
      { ...PAGE, referrer: "https://www.acme.example/other" },
      { ...PAGE, referrer: "not a url at all" },
    ]));
    expect(kept()[0].events.map(({ referrer }) => referrer)).toEqual(["news.example", null, null]);
  });

  it("drops what isn't a country", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE], { country: "nowhere" }));
    expect(kept()[0].events[0].country).toBeNull();
  });
});

describe("who may send", () => {
  it("refuses a key this instance didn't issue, before asking anything", async () => {
    const directory = vi.fn(async () => DIRECTORY);
    const { all } = ports({ directory });
    expect((await collect(all, request([PAGE], {}, { key: "site_forged" }))).status).toBe(404);
    expect(directory).not.toHaveBeenCalled();
  });

  it("refuses a real key for a site that's gone, or a key that was replaced", async () => {
    const { all } = ports({ directory: async () => [] });
    expect((await collect(all, request([PAGE]))).status).toBe(404);
  });

  it("refuses a page on another domain, and accepts subdomains of an allowed one", async () => {
    const { all } = ports();
    expect((await collect(all, request([PAGE], { origin: "https://evil.example" }))).status).toBe(403);
    expect((await collect(all, request([PAGE], { origin: "https://acme.example.evil.example" }))).status).toBe(403);
    expect((await collect(all, request([PAGE], { origin: "https://notacme.example" }))).status).toBe(403);
    expect((await collect(all, request([PAGE], { origin: "https://shop.acme.example" }))).status).toBe(202);
  });

  it("refuses a browser with no origin to check", async () => {
    const { all } = ports();
    expect((await collect(all, request([PAGE], { origin: null }))).status).toBe(403);
  });

  it("refuses a browser that claims to be a server", async () => {
    const { all } = ports();
    expect((await collect(all, request([{ kind: "event", name: "x" }], {}, { server: true }))).status).toBe(403);
  });

  it("takes a server's event, with no visitor, no bot filter, and only events", async () => {
    const { all, kept } = ports();
    const answer = await collect(all, request([{ kind: "event", name: "paid", userId: "user_1" }, PAGE], { origin: null, userAgent: "node" }, { server: true }));
    expect(answer).toMatchObject({ status: 202, accepted: 1 });
    expect(kept()[0].events[0]).toMatchObject({ name: "paid", userId: "user_1", visitor: null, browser: null, country: null });
  });

  it("keeps events when nobody can say who may send, and leaves the check to the flush", async () => {
    const { all, kept } = ports({ directory: async () => null });
    expect((await collect(all, request([PAGE], { origin: "https://anywhere.example" }))).status).toBe(202);
    expect(kept()[0]).toMatchObject({ verified: false, originHost: "anywhere.example", key: KEY });
  });
});

describe("what isn't a person", () => {
  it.each(["Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/140.0.0.0 Safari/537.36", "curl/8.4.0", "Mozilla/5.0 (compatible; bingbot/2.0)", "python-requests/2.31", "Mozilla/5.0 Chrome/140 Lighthouse"])("answers %s normally and keeps nothing", async (userAgent) => {
    const { all, kept } = ports();
    expect(await collect(all, request([PAGE], { userAgent }))).toMatchObject({ status: 202, accepted: 0 });
    expect(kept()).toEqual([]);
  });

  it("keeps nothing without a user agent", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE], { userAgent: null }));
    expect(kept()).toEqual([]);
  });

  it("doesn't count a browser fetching a page ahead of time", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE], { prefetch: true }));
    expect(kept()).toEqual([]);
  });
});

describe("limits", () => {
  it("refuses more than it reads", async () => {
    const { all } = ports();
    expect((await collect(all, request([PAGE], { body: "x".repeat(LARGEST_BODY_BYTES + 1) }))).status).toBe(413);
  });

  it("refuses what doesn't parse, and too many events at once", async () => {
    const { all } = ports();
    expect((await collect(all, request([PAGE], { body: "{not json" }))).status).toBe(400);
    expect((await collect(all, request([PAGE], { body: "[]" }))).status).toBe(400);
    expect((await collect(all, request(Array.from({ length: MOST_EVENTS_IN_A_BATCH + 1 }, () => PAGE)))).status).toBe(400);
  });

  it("drops an event with oversized fields", async () => {
    const { all, kept } = ports();
    await collect(all, request([PAGE, { kind: "event", name: "x".repeat(65) }, { kind: "event", name: "y", props: { a: "z".repeat(257) } }, { kind: "event", name: "z", props: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, 1])) }]));
    expect(kept()[0].events).toHaveLength(1);
  });

  it("limits a visitor per minute, says when to come back, and lets them in the next minute", async () => {
    const { all, kept } = ports();
    for (let count = 0; count < REQUESTS_PER_VISITOR_MINUTE; count += 1) expect((await collect(all, request([PAGE]))).status).toBe(202);
    const refused = await collect(all, request([PAGE]));
    expect(refused).toMatchObject({ status: 429, retryAfter: 60 });
    expect(kept()).toHaveLength(REQUESTS_PER_VISITOR_MINUTE);
    const later = await collect({ ...all, now: () => new Date(NOW.getTime() + 60_000) }, request([PAGE]));
    expect(later.status).toBe(202);
  });

  it("limits one visitor without touching another", async () => {
    const { all } = ports();
    for (let count = 0; count <= REQUESTS_PER_VISITOR_MINUTE; count += 1) await collect(all, request([PAGE]));
    expect((await collect(all, request([PAGE]))).status).toBe(429);
    expect((await collect(all, request([PAGE], { address: "203.0.113.8" }))).status).toBe(202);
  });

  it("limits a site from everywhere", async () => {
    const { RateWindow } = await import("@/domain/rate-window");
    const { all } = ports({ limits: { visitors: new RateWindow(100), sites: new RateWindow(2) } });
    const from = (address: string) => collect(all, request([PAGE], { address }));
    expect((await from("203.0.113.1")).status).toBe(202);
    expect((await from("203.0.113.2")).status).toBe(202);
    expect((await from("203.0.113.3")).status).toBe(429);
  });
});

describe("when the buffer can't keep it", () => {
  it("says so rather than pretending: nothing it didn't keep gets a 202", async () => {
    const { all } = ports({ buffer: { append: async () => { throw new Error("Down"); }, claim: async () => [] } });
    expect(await collect(all, request([PAGE]))).toMatchObject({ status: 503, accepted: 0, retryAfter: 60 });
  });
});

describe("a relay on the site's own domain", () => {
  const relay = (key: string) => ({ key, address: "198.51.100.9", country: "DE" });
  const hashOf = async (overrides: Partial<IncomingRequest>) => {
    const { all, kept } = ports();
    await collect(all, request([PAGE], overrides));
    return kept()[0].events[0];
  };

  it("speaks for its visitor, with the key that proves it's the site's own", async () => {
    const direct = await hashOf({ address: "198.51.100.9", country: "DE" });
    const relayed = await hashOf({ address: "76.76.21.21", country: "US", relay: relay(relayKeyOf(SITE_ID, SECRET)) });
    expect(relayed.visitor).toBe(direct.visitor);
    expect(relayed.country).toBe("DE");
  });

  it("is ignored without the right key: the connection is who it is", async () => {
    const direct = await hashOf({ address: "76.76.21.21", country: "US" });
    const forged = await hashOf({ address: "76.76.21.21", country: "US", relay: relay("relay_guess") });
    expect(forged.visitor).toBe(direct.visitor);
    expect(forged.country).toBe("US");
  });

  it("only works for its own site", async () => {
    const other = await hashOf({ address: "76.76.21.21", relay: relay(relayKeyOf("11111111-2222-4333-8444-666666666666", SECRET)) });
    const direct = await hashOf({ address: "76.76.21.21" });
    expect(other.visitor).toBe(direct.visitor);
  });
});

describe("a preflight", () => {
  const base = { secret: SECRET, directory: async () => DIRECTORY };

  it("is allowed only for a site's own domains", async () => {
    expect(await allowedOriginFor(base, KEY, "https://www.acme.example")).toBe("https://www.acme.example");
    expect(await allowedOriginFor(base, KEY, "https://evil.example")).toBeNull();
  });

  it("is refused without a key, with a forged key or without an origin", async () => {
    expect(await allowedOriginFor(base, null, "https://www.acme.example")).toBeNull();
    expect(await allowedOriginFor(base, "site_forged", "https://www.acme.example")).toBeNull();
    expect(await allowedOriginFor(base, KEY, null)).toBeNull();
  });
});
