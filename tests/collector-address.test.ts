import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/not-found/route";
import { collectorOnly, hostOfCollector, NOTHING_HERE, notOnTheCollector } from "@/domain/collector-address";
import { collectorEndpoint, collectorOrigin } from "@/infrastructure/env";

const INSTANCE = { BETTER_AUTH_URL: "https://analytics.company.example", TRAILIC_COLLECTOR_URL: undefined };
const SEPARATE = { ...INSTANCE, TRAILIC_COLLECTOR_URL: "https://collect.neutral.example" };

describe("where pages send", () => {
  it("is the instance's own address unless it has one for the collector", () => {
    expect(collectorEndpoint(INSTANCE)).toBe("https://analytics.company.example/api/e");
    expect(collectorOrigin(INSTANCE)).toBe("https://analytics.company.example");
    expect(collectorEndpoint(SEPARATE)).toBe("https://collect.neutral.example/api/e");
    expect(collectorOrigin(SEPARATE)).toBe("https://collect.neutral.example");
  });
});

describe("the collector's own address", () => {
  const host = hostOfCollector(SEPARATE.TRAILIC_COLLECTOR_URL);
  const [rule] = collectorOnly(host);
  const pattern = new RegExp(`^${rule.source}$`);

  it("is only about that host", () => {
    expect(rule.has).toEqual([{ type: "host", value: "collect.neutral.example" }]);
    expect(rule.destination).toBe(NOTHING_HERE);
    expect(notOnTheCollector(host)).toEqual({ missing: [{ type: "host", value: "collect.neutral.example" }] });
  });

  it("answers the collector and nothing else", () => {
    expect(pattern.test("/api/e")).toBe(false);
    for (const path of ["/", "/overview", "/sign-in", "/api/mcp", "/api/auth/jwks", "/api/e/x", "/api/events", "/_next/static/chunks/a.js", "/.well-known/oauth-authorization-server"]) {
      expect(pattern.test(path), path).toBe(true);
    }
  });

  it("changes nothing on an instance without one", () => {
    expect(hostOfCollector(undefined)).toBeNull();
    expect(collectorOnly(null)).toEqual([]);
    expect(notOnTheCollector(null)).toEqual({});
  });

  it("says nothing at all", async () => {
    for (const answer of [GET(), POST()]) {
      expect(answer.status).toBe(404);
      expect(await answer.text()).toBe("");
    }
  });
});
