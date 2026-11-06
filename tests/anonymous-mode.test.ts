import { describe, expect, it } from "vitest";
import { collect, newLimits, type CollectorPorts, type IncomingRequest } from "@/application/collect";
import type { DirectoryEntry } from "@/application/sites";
import { isPersonalArea, PERSONAL_AREAS, shortenedAddress } from "@/domain/anonymous";
import type { BufferedBatch } from "@/domain/collected";
import { mintSiteKey, relayKeyOf } from "@/infrastructure/crypto/site-key";
import type { WireEvent } from "../packages/trailic/src/wire";
import { memoryBuffer, NOW, SECRET } from "./support/analytics";

const SITE_ID = "11111111-2222-4333-8444-555555555555";
const KEY = mintSiteKey(SITE_ID, SECRET);
const ANONYMOUS: DirectoryEntry[] = [{ siteId: SITE_ID, key: KEY, allowedDomains: ["acme.example"], anonymous: true }];
const NAMED: DirectoryEntry[] = [{ ...ANONYMOUS[0], anonymous: false }];
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

function collector(directory: readonly DirectoryEntry[] | null) {
  const buffer = memoryBuffer();
  const ports: CollectorPorts = { secret: SECRET, buffer, directory: async () => directory, limits: newLimits(), now: () => NOW };
  return { ports, events: () => buffer.waiting.flatMap(({ batch }) => (batch as BufferedBatch).events) };
}

const request = (events: WireEvent[], overrides: Partial<IncomingRequest> = {}, server = false): IncomingRequest => ({
  body: JSON.stringify({ key: KEY, events, ...(server ? { server } : {}) }),
  origin: server ? null : "https://www.acme.example",
  userAgent: FIREFOX,
  address: "203.0.113.7",
  country: "FR",
  prefetch: false,
  relay: null,
  ...overrides,
});

const PAGE: WireEvent = { kind: "page", path: "/pricing" };

async function visitorsOf(directory: readonly DirectoryEntry[], ...addresses: string[]) {
  const { ports, events } = collector(directory);
  for (const address of addresses) await collect(ports, request([PAGE], { address }));
  return events().map(({ visitor }) => visitor);
}

describe("anonymous mode, at the collector", () => {
  it("hashes the shortened address, so one /24 is one visitor per browser", async () => {
    const [first, second, elsewhere] = await visitorsOf(ANONYMOUS, "203.0.113.7", "203.0.113.200", "203.0.114.7");
    expect(first).toBe(second);
    expect(elsewhere).not.toBe(first);
  });

  it("does the same with a /48", async () => {
    const [first, second, elsewhere] = await visitorsOf(ANONYMOUS, "2001:db8:1:2::1", "2001:0db8:0001:ffff::9", "2001:db8:2::1");
    expect(first).toBe(second);
    expect(elsewhere).not.toBe(first);
  });

  it("tells them apart when it's off", async () => {
    const [first, second] = await visitorsOf(NAMED, "203.0.113.7", "203.0.113.200");
    expect(first).not.toBe(second);
  });

  it("shortens what a relay says about the visitor too", async () => {
    const { ports, events } = collector(ANONYMOUS);
    const relayed = (address: string): Partial<IncomingRequest> => ({ address: "198.51.100.1", relay: { key: relayKeyOf(SITE_ID, SECRET), address, country: "FR" } });
    await collect(ports, request([PAGE], relayed("203.0.113.7")));
    await collect(ports, request([PAGE], relayed("203.0.113.8")));
    const [first, second] = events();
    expect(first.visitor).toBe(second.visitor);
  });

  it("drops UTM tags, leaving the path clean", async () => {
    const { ports, events } = collector(ANONYMOUS);
    await collect(ports, request([{ kind: "page", path: "/pricing?utm_source=mail&utm_medium=x&utm_campaign=y&utm_term=z&utm_content=w" }]));
    expect(events()[0]).toMatchObject({ path: "/pricing", utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null });
  });

  it("keeps them when it's off", async () => {
    const { ports, events } = collector(NAMED);
    await collect(ports, request([{ kind: "page", path: "/pricing?utm_source=mail" }]));
    expect(events()[0].utmSource).toBe("mail");
  });

  it("refuses identify, keeping what came with it", async () => {
    const { ports, events } = collector(ANONYMOUS);
    const answer = await collect(ports, request([PAGE, { kind: "identify", userId: "user_1", traits: { plan: "pro" } }]));
    expect(answer).toMatchObject({ status: 202, accepted: 1 });
    expect(events().map(({ kind }) => kind)).toEqual(["page"]);
  });

  it("answers an identify alone without saying it was dropped", async () => {
    const { ports, events } = collector(ANONYMOUS);
    const answer = await collect(ports, request([{ kind: "identify", userId: "user_1" }]));
    expect(answer).toMatchObject({ status: 202, accepted: 0, allowOrigin: "https://www.acme.example" });
    expect(events()).toEqual([]);
  });

  it("drops a user id from any event, from a browser or a server", async () => {
    const { ports, events } = collector(ANONYMOUS);
    await collect(ports, request([{ ...PAGE, userId: "user_1" }]));
    await collect(ports, request([{ kind: "event", name: "payment", userId: "user_1", props: { amount: 49 } }], {}, true));
    expect(events().map(({ userId }) => userId)).toEqual([null, null]);
    expect(events()[1].props).toEqual({ amount: 49 });
  });

  it("still takes identify when it's off", async () => {
    const { ports, events } = collector(NAMED);
    await collect(ports, request([{ kind: "identify", userId: "user_1", traits: { plan: "pro" } }]));
    expect(events()[0]).toMatchObject({ kind: "identify", userId: "user_1", traits: { plan: "pro" } });
  });

  it("keeps no one's name from a profile page", async () => {
    const { ports, events } = collector(ANONYMOUS);
    await collect(ports, request([{ kind: "page", path: "/u/someone" }, { kind: "page", path: "/en/users/someone" }, { kind: "event", name: "copy", path: "/profile/someone" }]));
    expect(events()).toEqual([]);
  });

  it("counts nothing from a sign-in, account or admin area, and says nothing about it", async () => {
    const { ports, events } = collector(ANONYMOUS);
    const answer = await collect(ports, request([{ kind: "page", path: "/fr/login" }, { kind: "event", name: "copy", path: "/admin/users" }]));
    expect(answer).toMatchObject({ status: 202, accepted: 0, allowOrigin: "https://www.acme.example" });
    expect(events()).toEqual([]);
  });

  it("keeps the rest of a batch that has such a page in it", async () => {
    const { ports, events } = collector(ANONYMOUS);
    await collect(ports, request([{ kind: "page", path: "/dashboard" }, PAGE, { kind: "page", path: "/blog/login-attacks" }]));
    expect(events().map(({ path }) => path)).toEqual(["/pricing", "/blog/login-attacks"]);
  });

  it("keeps what has no path, like an event from a server", async () => {
    const { ports, events } = collector(ANONYMOUS);
    await collect(ports, request([{ kind: "event", name: "payment" }], {}, true));
    expect(events().map(({ name }) => name)).toEqual(["payment"]);
  });

  it("counts them when it's off", async () => {
    const { ports, events } = collector(NAMED);
    await collect(ports, request([{ kind: "page", path: "/login" }]));
    expect(events().map(({ path }) => path)).toEqual(["/login"]);
  });

  it("assumes it's on when nobody can say what the site asked for", async () => {
    const { ports, events } = collector(null);
    await collect(ports, request([{ kind: "page", path: "/x?utm_source=mail" }, { kind: "identify", userId: "user_1" }]));
    expect(events()).toHaveLength(1);
    expect(events()[0].utmSource).toBeNull();
  });
});

describe("a personal area", () => {
  it.each(PERSONAL_AREAS.flatMap((area) => [`/${area}`, `/${area}/`, `/${area}/deep/down`, `/en/${area}`, `/fr/${area}/x`, `/pt-br/${area}`, `/${area.toUpperCase()}`, `/${area}?next=/x`]))("%s isn't counted", (path) => {
    expect(isPersonalArea(path)).toBe(true);
  });

  it.each(["/", "/en", "/pricing", "/admin-tools-guide", "/login-attacks", "/accounts", "/settings-guide", "/dashboards", "/author", "/en/admin-tools-guide", "/blog/login-attacks", "/blog/admin", "/en/blog/login", "/docs/auth/setup", "/en/en/login", "/universities", "/uses", "/user-guide", "/users-guide", "/profiles", "/profile-picture-tips", "/mention", "/menu", "/fr/menu", "/onboarding-guide", "/favorite", "/portals", "/blog/u/x", "/questionnaire", "/resultats", "/results", "/learn"])("%s is an ordinary page", (path) => {
    expect(isPersonalArea(path)).toBe(false);
  });
});

describe("a shortened address", () => {
  it.each([
    ["203.0.113.7", "203.0.113.0"],
    [" 203.0.113.7 ", "203.0.113.0"],
    ["::ffff:203.0.113.7", "203.0.113.0"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1::"],
    ["2001:0DB8:0001:ffff::9", "2001:db8:1::"],
    ["2001:db8::1", "2001:db8:0::"],
    ["::1", "0:0:0::"],
    ["fe80::1%en0", "fe80:0:0::"],
    ["", ""],
    ["not an address", ""],
  ])("%s becomes %s", (address, shortened) => {
    expect(shortenedAddress(address)).toBe(shortened);
  });
});
