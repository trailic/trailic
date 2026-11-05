import { describe, expect, it } from "vitest";
import { randomToken, sameSecret, sha256 } from "@/infrastructure/crypto/secrets";
import { mintSiteKey, relayKeyOf, siteIdOfKey } from "@/infrastructure/crypto/site-key";
import { dailySalt, visitorOf } from "@/infrastructure/crypto/visitor-hash";

const SITE = "11111111-2222-4333-8444-555555555555";
const SECRET = "a-long-enough-secret-for-site-keys-in-tests";

describe("small things that are secret", () => {
  it("makes tokens, hashes and compares in constant time", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(sha256("a")).toHaveLength(64);
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});

describe("a site's public key", () => {
  it("says which site it is for, without reading anything", () => {
    const key = mintSiteKey(SITE, SECRET);
    expect(key.startsWith("site_")).toBe(true);
    expect(siteIdOfKey(key, SECRET)).toBe(SITE);
  });

  it("differs each time, so a replaced key can be told from the new one", () => {
    expect(mintSiteKey(SITE, SECRET)).not.toBe(mintSiteKey(SITE, SECRET));
  });

  it("is refused when forged, altered, made with another secret or not a key at all", () => {
    const key = mintSiteKey(SITE, SECRET);
    expect(siteIdOfKey(`${key.slice(0, 10)}${key[10] === "A" ? "B" : "A"}${key.slice(11)}`, SECRET)).toBeNull();
    expect(siteIdOfKey(key, "another-secret-entirely-long-enough-too")).toBeNull();
    for (const notAKey of ["", "site_", "site_abc", 42, null, undefined, {}, `${key}x`]) expect(siteIdOfKey(notAKey, SECRET)).toBeNull();
  });

  it("gives a relay a key of its own, per site", () => {
    expect(relayKeyOf(SITE, SECRET)).toBe(relayKeyOf(SITE, SECRET));
    expect(relayKeyOf(SITE, SECRET)).not.toBe(relayKeyOf("11111111-2222-4333-8444-666666666666", SECRET));
    expect(relayKeyOf(SITE, SECRET).startsWith("relay_")).toBe(true);
  });
});

describe("an anonymous visitor's hash", () => {
  const input = { secret: SECRET, siteId: SITE, day: "2026-11-05", address: "203.0.113.7", userAgent: "Mozilla/5.0 Firefox/140" };

  it("is the same person all day", () => {
    expect(visitorOf(input)).toBe(visitorOf({ ...input }));
    expect(visitorOf(input)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("rotates at midnight, because the salt does", () => {
    expect(dailySalt(SECRET, "2026-11-05")).not.toBe(dailySalt(SECRET, "2026-11-06"));
    expect(visitorOf(input)).not.toBe(visitorOf({ ...input, day: "2026-11-06" }));
  });

  it("can't be compared between two sites", () => {
    expect(visitorOf(input)).not.toBe(visitorOf({ ...input, siteId: "11111111-2222-4333-8444-666666666666" }));
  });

  it("tells apart another address and another browser", () => {
    expect(visitorOf(input)).not.toBe(visitorOf({ ...input, address: "203.0.113.8" }));
    expect(visitorOf(input)).not.toBe(visitorOf({ ...input, userAgent: "Mozilla/5.0 Chrome/140" }));
  });

  it("holds nothing of what went into it", () => {
    const hash = visitorOf(input);
    expect(hash).not.toContain("203");
    expect(hash).not.toContain("113");
  });

  it("depends on the instance's secret, so nobody else can work it out", () => {
    expect(visitorOf(input)).not.toBe(visitorOf({ ...input, secret: "another-secret-entirely-long-enough-too" }));
  });
});
