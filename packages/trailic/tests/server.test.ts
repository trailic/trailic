// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_PARTY_PATH, trailicRelay, trailicRewrite } from "../src/next.js";
import { trackServer } from "../src/server.js";

const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 202 }));

beforeEach(() => {
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

describe("trackServer", () => {
  it("sends one event, marked as a server's, and says it was taken", async () => {
    expect(await trackServer("paid", { plan: "pro" }, { siteKey: "site_k", endpoint: "https://c.example/api/e", userId: "user_1" })).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://c.example/api/e");
    expect(lastBody()).toEqual({ key: "site_k", server: true, events: [{ kind: "event", name: "paid", props: { plan: "pro" }, userId: "user_1" }] });
  });

  it("reads its settings from the environment", async () => {
    vi.stubEnv("TRAILIC_SITE_KEY", "site_env");
    vi.stubEnv("TRAILIC_ENDPOINT", "https://c.example/api/e");
    await trackServer("paid");
    expect(lastBody().key).toBe("site_env");
    expect(lastBody().events[0]).toEqual({ kind: "event", name: "paid" });
  });

  it("says no rather than throwing: no settings, a refusal, a failure, a timeout", async () => {
    expect(await trackServer("paid")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 403 }));
    expect(await trackServer("paid", undefined, { siteKey: "k", endpoint: "https://c.example" })).toBe(false);
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await trackServer("paid", undefined, { siteKey: "k", endpoint: "https://c.example" })).toBe(false);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the first-party rewrite", () => {
  it("sends a path on this domain to the collector", () => {
    expect(trailicRewrite("https://trailic.acme.example")).toEqual({ source: FIRST_PARTY_PATH, destination: "https://trailic.acme.example/api/e" });
    expect(trailicRewrite("https://trailic.acme.example/", "/t")).toEqual({ source: "/t", destination: "https://trailic.acme.example/api/e" });
  });
});

describe("the first-party relay", () => {
  const request = (headers: Record<string, string> = {}) => new Request("https://shop.acme.example/trailic/e", { method: "POST", body: '{"key":"site_k","events":[]}', headers: { "user-agent": "Mozilla/5.0", origin: "https://shop.acme.example", "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-vercel-ip-country": "FR", ...headers } });
  const relay = trailicRelay({ collector: "https://trailic.acme.example", relayKey: "relay_k" });

  it("says who the visitor is, with the key that proves it's the site's own, and passes the body on", async () => {
    const answer = await relay(request());
    expect(answer.status).toBe(202);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://trailic.acme.example/api/e");
    expect(init?.body).toBe('{"key":"site_k","events":[]}');
    expect(init?.headers).toMatchObject({ "x-trailic-relay": "relay_k", "x-trailic-address": "203.0.113.7", "x-trailic-country": "FR", "user-agent": "Mozilla/5.0", origin: "https://shop.acme.example" });
  });

  it("falls back on X-Real-IP", async () => {
    await relay(request({ "x-forwarded-for": "", "x-real-ip": "203.0.113.9" }));
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "x-trailic-address": "203.0.113.9" });
  });

  it("reads its settings from the environment", async () => {
    vi.stubEnv("TRAILIC_URL", "https://trailic.acme.example");
    vi.stubEnv("TRAILIC_RELAY_KEY", "relay_env");
    await trailicRelay()(request());
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "x-trailic-relay": "relay_env" });
  });

  it("answers plainly without settings or a collector, and never throws", async () => {
    expect((await trailicRelay()(request())).status).toBe(503);
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await relay(request())).status).toBe(502);
  });
});
