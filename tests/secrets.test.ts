import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { randomToken, sameSecret, sha256 } from "@/infrastructure/crypto/secrets";
import { mintSiteKey, relayKeyOf, siteIdOfKey } from "@/infrastructure/crypto/site-key";
import { senderOf } from "@/infrastructure/crypto/sender-hash";
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

describe("the hash a sender is counted by", () => {
  const ADDRESS = "203.0.113.7";

  it("is the same for the same address, and another for another", () => {
    expect(senderOf(SECRET, ADDRESS)).toBe(senderOf(SECRET, ADDRESS));
    expect(senderOf(SECRET, ADDRESS)).not.toBe(senderOf(SECRET, "203.0.113.8"));
  });

  it("says nothing without the instance's secret, and nothing of the address", () => {
    expect(senderOf(SECRET, ADDRESS)).not.toBe(senderOf("another-secret-entirely-long-enough-too", ADDRESS));
    expect(senderOf(SECRET, ADDRESS)).not.toContain(ADDRESS);
    expect(senderOf(SECRET, ADDRESS)).toMatch(/^[\w-]{43}$/);
  });

  it("is under a key of its own, not the secret itself", () => {
    expect(senderOf(SECRET, ADDRESS)).not.toBe(createHmac("sha256", SECRET).update(ADDRESS).digest("base64url"));
  });

  it("leaves the visitor hash exactly as it was: what's been counted so far still counts as the same people", () => {
    const input = { secret: SECRET, siteId: SITE, day: "2026-11-05", address: ADDRESS, userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" };
    expect(visitorOf(input)).toBe("2540685a-78b8-2571-ec8c-3058b57c3bf2");
  });
});
