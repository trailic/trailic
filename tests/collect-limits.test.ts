import { afterEach, describe, expect, it, vi } from "vitest";
import { collect, newLimits, REQUESTS_PER_INSTANCE_MINUTE, REQUESTS_PER_SENDER_MINUTE, REQUESTS_PER_SITE_MINUTE, REQUESTS_PER_VISITOR_MINUTE, type CollectorPorts, type IncomingRequest } from "@/application/collect";
import type { DirectoryEntry } from "@/application/sites";
import type { BufferedBatch } from "@/domain/collected";
import { RateWindow, RefusalTally } from "@/domain/rate-window";
import { mintSiteKey, relayKeyOf } from "@/infrastructure/crypto/site-key";
import { memoryBuffer, NOW, SECRET } from "./support/analytics";

/** As many sites as a real instance can have: one sender spreading over them is what these limits are for. */
const SITES: DirectoryEntry[] = Array.from({ length: 163 }, (_, index) => {
  const siteId = `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`;
  return { siteId, key: mintSiteKey(siteId, SECRET), allowedDomains: ["acme.example"], anonymous: false };
});
const ADDRESS = "203.0.113.7";
const PAGE = { kind: "page", path: "/pricing" };

function ports(limits: Partial<CollectorPorts["limits"]> = {}, now = NOW) {
  const buffer = memoryBuffer();
  const append = vi.spyOn(buffer, "append");
  const directory = vi.fn(async () => SITES);
  const all: CollectorPorts = { secret: SECRET, buffer, directory, limits: { ...newLimits(), ...limits }, now: () => now };
  return { all, append, directory, kept: () => buffer.waiting.map(({ batch }) => batch as BufferedBatch) };
}

/** A different browser and site each time, so that only a limit across all of them can notice it's one sender. */
function sent(attempt: number, overrides: Partial<IncomingRequest> = {}, batch: Record<string, unknown> = {}): IncomingRequest {
  const { key } = SITES[attempt % SITES.length];
  return { body: JSON.stringify({ key, events: [PAGE], ...batch }), origin: "https://www.acme.example", userAgent: `Mozilla/5.0 (X11; Linux x86_64; rv:${attempt}.0) Gecko/20100101 Firefox/${attempt}.0`, address: ADDRESS, country: "FR", prefetch: false, relay: null, ...overrides };
}

const addressNumber = (number: number) => `198.${(number >> 16) & 255}.${(number >> 8) & 255}.${number & 255}`;

async function times(count: number, send: (attempt: number) => ReturnType<typeof collect>) {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) statuses.push((await send(attempt)).status);
  return statuses;
}

afterEach(() => vi.restoreAllMocks());

describe("one sender, however it spreads", () => {
  it("gets 600 requests a minute through, across all 163 sites, whatever key or browser it shows", async () => {
    const { all, kept } = ports();
    const statuses = await times(5_000, (attempt) => collect(all, sent(attempt)));
    expect(kept()).toHaveLength(600);
    expect(new Set(kept().map(({ siteId }) => siteId)).size).toBe(SITES.length);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4_400);
  });

  it("says when to come back, gives another site's page nothing to read, and lets it in the next minute", async () => {
    const { all } = ports();
    await times(REQUESTS_PER_SENDER_MINUTE, (attempt) => collect(all, sent(attempt)));
    expect(await collect(all, sent(0))).toMatchObject({ status: 429, retryAfter: 60, allowOrigin: null, accepted: 0 });
    expect((await collect({ ...all, now: () => new Date(NOW.getTime() + 60_000) }, sent(0))).status).toBe(202);
  });

  it("costs no queue operation and no look at the directory once refused", async () => {
    const { all, append, directory } = ports();
    await times(REQUESTS_PER_SENDER_MINUTE, (attempt) => collect(all, sent(attempt)));
    append.mockClear();
    directory.mockClear();
    const statuses = await times(100, (attempt) => collect(all, sent(attempt)));
    expect(new Set(statuses)).toEqual(new Set([429]));
    expect(append).not.toHaveBeenCalled();
    expect(directory).not.toHaveBeenCalled();
  });

  it("leaves another sender alone", async () => {
    const { all } = ports();
    await times(REQUESTS_PER_SENDER_MINUTE + 1, (attempt) => collect(all, sent(attempt)));
    expect((await collect(all, sent(0, { address: "203.0.113.8" }))).status).toBe(202);
  });

  it("can't claim to be a server to get out of it", async () => {
    const { all } = ports();
    const statuses = await times(REQUESTS_PER_SENDER_MINUTE + 1, (attempt) => collect(all, sent(attempt, { origin: null, userAgent: "node" }, { server: true, events: [{ kind: "event", name: "paid" }] })));
    expect(statuses.at(-2)).toBe(202);
    expect(statuses.at(-1)).toBe(429);
  });

  it("counts a whole IPv6 network as one, since one customer holds billions of its addresses", async () => {
    const { all } = ports();
    const statuses = await times(REQUESTS_PER_SENDER_MINUTE + 1, (attempt) => collect(all, sent(attempt, { address: `2001:db8:1:2::${attempt.toString(16)}` })));
    expect(statuses.at(-1)).toBe(429);
    expect((await collect(all, sent(0, { address: "2001:db8:1:3::1" }))).status).toBe(202);
  });

  it("counts an IPv4 address however it's written", async () => {
    const { all } = ports();
    await times(REQUESTS_PER_SENDER_MINUTE, (attempt) => collect(all, sent(attempt)));
    expect((await collect(all, sent(0, { address: `::ffff:${ADDRESS}` }))).status).toBe(429);
  });

  it("doesn't count a forged key, which costs nothing and proves nothing", async () => {
    const { all } = ports();
    const forged = sent(0, {}, { key: "site_forged" });
    expect(new Set(await times(REQUESTS_PER_SENDER_MINUTE + 1, () => collect(all, forged)))).toEqual(new Set([404]));
    expect((await collect(all, sent(0))).status).toBe(202);
  });
});

describe("real people behind one address", () => {
  it("takes ten times the busiest minute a whole real instance has seen, from one office or carrier", async () => {
    const BUSIEST_MINUTE_MEASURED = 39;
    const { all, kept } = ports();
    const statuses = await times(BUSIEST_MINUTE_MEASURED * 10, (attempt) => collect(all, sent(attempt)));
    expect(new Set(statuses)).toEqual(new Set([202]));
    expect(kept()).toHaveLength(BUSIEST_MINUTE_MEASURED * 10);
  });

  it("leaves room for several people at the limit one browser on one site has", () => {
    expect(REQUESTS_PER_SENDER_MINUTE).toBeGreaterThanOrEqual(REQUESTS_PER_VISITOR_MINUTE * 5);
  });

  it("lets a relay speak for many visitors, each counted as themselves", async () => {
    const { all, kept } = ports();
    const relayed = (attempt: number) => {
      const { siteId } = SITES[0];
      return sent(0, { address: "76.76.21.21", relay: { key: relayKeyOf(siteId, SECRET), address: addressNumber(attempt), country: "FR" } });
    };
    const statuses = await times(REQUESTS_PER_SENDER_MINUTE + 50, (attempt) => collect(all, relayed(attempt)));
    expect(new Set(statuses)).toEqual(new Set([202]));
    expect(kept()).toHaveLength(REQUESTS_PER_SENDER_MINUTE + 50);
  });

  it("limits a visitor who floods through a relay, by their own address", async () => {
    const { all } = ports();
    const { siteId } = SITES[0];
    const statuses = await times(REQUESTS_PER_SENDER_MINUTE + 1, (attempt) => collect(all, sent(attempt * SITES.length, { address: "76.76.21.21", relay: { key: relayKeyOf(siteId, SECRET), address: ADDRESS, country: "FR" } })));
    expect(statuses.at(-1)).toBe(429);
  });

  it("gives a claimed relay no way around it: without the key, the connection is the sender", async () => {
    const { all } = ports();
    const statuses = await times(REQUESTS_PER_SENDER_MINUTE + 1, (attempt) => collect(all, sent(attempt, { relay: { key: "relay_guess", address: addressNumber(attempt), country: "FR" } })));
    expect(statuses.at(-1)).toBe(429);
  });

  it("counts no sender when there's no address to tell them apart: everyone would be one", async () => {
    const { all } = ports();
    for (const address of ["", "not an address"]) {
      const statuses = await times(REQUESTS_PER_SENDER_MINUTE + 1, (attempt) => collect(all, sent(attempt, { address })));
      expect(new Set(statuses)).toEqual(new Set([202]));
    }
  });
});

describe("the whole instance", () => {
  const fromEveryone = (attempt: number, overrides: Partial<IncomingRequest> = {}) => sent(attempt, { address: addressNumber(attempt), ...overrides });

  it("takes 6,000 requests a minute from everywhere, and refuses the next at no cost at all", async () => {
    const { all, append, directory, kept } = ports();
    await times(REQUESTS_PER_INSTANCE_MINUTE, (attempt) => collect(all, fromEveryone(attempt)));
    expect(REQUESTS_PER_INSTANCE_MINUTE).toBe(6_000);
    expect(kept()).toHaveLength(6_000);
    append.mockClear();
    directory.mockClear();
    const answer = await collect(all, fromEveryone(REQUESTS_PER_INSTANCE_MINUTE));
    expect(answer).toMatchObject({ status: 429, retryAfter: 60, allowOrigin: null, accepted: 0 });
    expect(append).not.toHaveBeenCalled();
    expect(directory).not.toHaveBeenCalled();
    expect((await collect({ ...all, now: () => new Date(NOW.getTime() + 60_000) }, fromEveryone(1))).status).toBe(202);
  });

  it("holds when there's no address to go by", async () => {
    const { all, kept } = ports({ instance: new RateWindow(5) });
    const statuses = await times(6, (attempt) => collect(all, sent(attempt, { address: "" })));
    expect(statuses.at(-1)).toBe(429);
    expect(kept()).toHaveLength(5);
  });

  it("isn't used up by one sender: what that sender is refused leaves the allowance to everyone else", async () => {
    const { all } = ports({ instance: new RateWindow(REQUESTS_PER_SENDER_MINUTE + 1) });
    await times(REQUESTS_PER_SENDER_MINUTE * 2, (attempt) => collect(all, sent(attempt)));
    expect((await collect(all, sent(0, { address: "203.0.113.8" }))).status).toBe(202);
  });

  it("isn't used up by one flooded site: the others keep theirs", async () => {
    const { all } = ports({ sites: new RateWindow(2), instance: new RateWindow(3) });
    const onOneSite = (attempt: number) => collect(all, sent(0, { address: addressNumber(attempt), userAgent: "Mozilla/5.0 Firefox/140.0" }));
    expect(await times(10, onOneSite)).toEqual([202, 202, 429, 429, 429, 429, 429, 429, 429, 429]);
    expect((await collect(all, sent(1, { address: "203.0.113.8" }))).status).toBe(202);
    expect((await collect(all, sent(2, { address: "203.0.113.9" }))).status).toBe(429);
  });

  it("holds for requests in flight together, which all saw room before any of them was counted", async () => {
    const { all, kept } = ports({ instance: new RateWindow(2) });
    const answers = await Promise.all(Array.from({ length: 5 }, (_, attempt) => collect(all, fromEveryone(attempt))));
    expect(answers.map(({ status }) => status).sort()).toEqual([202, 202, 429, 429, 429]);
    expect(kept()).toHaveLength(2);
  });

  it("gives one site at most half of it, so a flood aimed at one site leaves the others room", () => {
    expect(REQUESTS_PER_SITE_MINUTE).toBeLessThanOrEqual(REQUESTS_PER_INSTANCE_MINUTE / 2);
  });

  it("isn't used up by what would never have reached the buffer", async () => {
    const { all } = ports({ instance: new RateWindow(1) });
    expect((await collect(all, fromEveryone(1, { origin: "https://evil.example" }))).status).toBe(403);
    expect(await collect(all, fromEveryone(2, { userAgent: "curl/8.4.0" }))).toMatchObject({ status: 202, accepted: 0 });
    expect(await collect(all, fromEveryone(3))).toMatchObject({ status: 202, accepted: 1 });
    expect((await collect(all, fromEveryone(4))).status).toBe(429);
  });
});

describe("what's left of a refusal", () => {
  const nextMinute = new Date(NOW.getTime() + 60_000);

  it("writes one line a minute with a count in it, whatever the flood", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { all } = ports();
    await times(REQUESTS_PER_SENDER_MINUTE + 250, (attempt) => collect(all, sent(attempt)));
    expect(warn).not.toHaveBeenCalled();
    await collect({ ...all, now: () => nextMinute }, sent(0));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('"sender":250');
  });

  it("writes it for every limit, each by name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { all } = ports({ instance: new RateWindow(3), sites: new RateWindow(3), visitors: new RateWindow(1) });
    const browser = { userAgent: "Mozilla/5.0 Firefox/140.0" };
    await collect(all, sent(0, browser)); // kept
    await collect(all, sent(0, browser)); // the visitor's limit
    await collect(all, sent(0, { address: "203.0.113.8" })); // kept
    await collect(all, sent(0, { address: "203.0.113.9" })); // the site's limit
    await collect(all, sent(1, { address: "203.0.113.10" })); // kept, and the last the instance takes
    await collect(all, sent(2, { address: "203.0.113.11" })); // the instance's limit
    await collect({ ...all, now: () => nextMinute }, sent(3));
    expect(JSON.parse(String(warn.mock.calls[0][0]).replace(/^[^{]*/, ""))).toEqual({ visitor: 1, site: 1, instance: 1 });
  });

  it("names nobody and nothing: no address, no hash, no key, no site, no browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { senderOf } = await import("@/infrastructure/crypto/sender-hash");
    const { all } = ports();
    await times(REQUESTS_PER_SENDER_MINUTE + 5, (attempt) => collect(all, sent(attempt)));
    await collect({ ...all, now: () => nextMinute }, sent(0));
    const line = warn.mock.calls.flat().join(" ");
    for (const value of [ADDRESS, "203.0.113", senderOf(SECRET, ADDRESS), SITES[0].key, SITES[0].siteId, "Firefox", "acme"]) expect(line).not.toContain(value);
    expect(line).toMatch(/^[^0-9]*\{"sender":5\}$/);
  });

  it("writes nothing when nothing was refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { all } = ports();
    await collect(all, sent(0));
    await collect({ ...all, now: () => nextMinute }, sent(0));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the hash a sender is counted by", () => {
  it("counts by that hash, never by the address, and it goes no further than the count", async () => {
    const { senderOf } = await import("@/infrastructure/crypto/sender-hash");
    const senders = new RateWindow(REQUESTS_PER_SENDER_MINUTE);
    const counted = vi.spyOn(senders, "take");
    const { all, kept } = ports({ senders });
    await collect(all, sent(0));
    expect(counted).toHaveBeenCalledWith(senderOf(SECRET, ADDRESS), NOW.getTime());
    const stored = JSON.stringify(kept());
    expect(stored).not.toContain(senderOf(SECRET, ADDRESS));
    expect(stored).not.toContain(ADDRESS);
  });
});

describe("a window", () => {
  const AT = NOW.getTime();

  it("says it's full without counting anything", () => {
    const window = new RateWindow(1);
    expect(window.full("a", AT)).toBe(false);
    expect(window.full("a", AT)).toBe(false);
    expect(window.take("a", AT)).toBe(true);
    expect(window.full("a", AT)).toBe(true);
    expect(window.take("a", AT)).toBe(false);
  });

  it("is empty again in the next window, asked either way", () => {
    const window = new RateWindow(1);
    window.take("a", AT);
    expect(window.full("a", AT + 60_000)).toBe(false);
    expect(window.take("a", AT + 60_000)).toBe(true);
  });

  it("hands over a finished minute's tally once, and only one with something in it", () => {
    const report = vi.fn();
    const tally = new RefusalTally<"one" | "two">(report);
    tally.add("one", AT);
    tally.add("one", AT);
    tally.add("two", AT);
    tally.settle(AT + 1_000);
    expect(report).not.toHaveBeenCalled();
    tally.settle(AT + 60_000);
    expect(report).toHaveBeenCalledExactlyOnceWith({ one: 2, two: 1 });
    tally.settle(AT + 120_000);
    tally.add("two", AT + 180_000);
    tally.settle(AT + 240_000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith({ two: 1 });
  });
});
