import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetEverything, identify, isOptedOut, optIn, optOut, recordVital, reset, setConsent, start, track } from "../src/core.js";
import type { WireBatch } from "../src/wire.js";

const ENDPOINT = "https://collect.acme.example/api/e";
const KEY = "site_key";
const options = { siteKey: KEY, endpoint: ENDPOINT };

const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
const beacon = vi.fn<(url: string, body: string) => boolean>(() => true);

const sentBy = (mock: { mock: { calls: unknown[][] } }, bodyAt: number, read: (call: unknown[]) => unknown = (call) => call[bodyAt]) => mock.mock.calls.map((call) => JSON.parse(read(call) as string) as WireBatch);
const fetched = () => sentBy(fetchMock as never, 1, (call) => (call[1] as RequestInit).body);
const beaconed = () => sentBy(beacon as never, 1);
const events = () => [...fetched(), ...beaconed()].flatMap((batch) => batch.events);

function at(path: string) {
  window.history.replaceState({}, "", path);
}

const hide = () => window.dispatchEvent(new Event("pagehide"));

beforeEach(() => {
  vi.useFakeTimers();
  forgetEverything();
  fetchMock.mockClear();
  beacon.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
  Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });
  Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: false });
  localStorage.clear();
  document.cookie = "";
  at("/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("page views", () => {
  it("counts the page it starts on, and waits a moment before sending", () => {
    at("/home");
    start(options);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(fetched()).toMatchObject([{ key: KEY, events: [{ kind: "page", path: "/home" }] }]);
  });

  it("sends as plain text, without credentials, so no preflight and no cookie", () => {
    start(options);
    vi.advanceTimersByTime(5_000);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect(typeof init.body).toBe("string");
    expect(init.headers).toBeUndefined();
  });

  it("counts a move through the history API, as Next's router makes", () => {
    at("/a");
    start(options);
    window.history.pushState({}, "", "/b");
    window.history.pushState({}, "", "/c?x=1");
    vi.advanceTimersByTime(5_000);
    expect(events().map(({ path }) => path)).toEqual(["/a", "/b", "/c"]);
  });

  it("counts going back", () => {
    at("/a");
    start(options);
    window.history.pushState({}, "", "/b");
    at("/a");
    window.dispatchEvent(new PopStateEvent("popstate"));
    vi.advanceTimersByTime(5_000);
    expect(events().map(({ path }) => path)).toEqual(["/a", "/b", "/a"]);
  });

  it("doesn't count the same page twice: not a dropped query, not Next replacing its state, not a second mount", () => {
    at("/a");
    const stop = start(options);
    window.history.replaceState({ scroll: 1 }, "", "/a");
    window.history.pushState({}, "", "/a?tab=2");
    stop();
    start(options);
    vi.advanceTimersByTime(5_000);
    expect(events().map(({ path }) => path)).toEqual(["/a"]);
  });

  it("stops listening when stopped", () => {
    at("/a");
    const stop = start(options);
    stop();
    window.history.pushState({}, "", "/b");
    vi.advanceTimersByTime(5_000);
    expect(events().map(({ path }) => path)).toEqual(["/a"]);
  });

  it("sends the referrer once, with the first page of a load", () => {
    Object.defineProperty(document, "referrer", { configurable: true, value: "https://news.example/story" });
    at("/a");
    start(options);
    window.history.pushState({}, "", "/b");
    vi.advanceTimersByTime(5_000);
    expect(events().map(({ referrer }) => referrer)).toEqual(["https://news.example/story", undefined]);
    Object.defineProperty(document, "referrer", { configurable: true, value: "" });
  });

  it("says how long ago each thing happened, not when", () => {
    at("/a");
    start(options);
    vi.advanceTimersByTime(2_000);
    track("later");
    vi.advanceTimersByTime(3_000);
    expect(events().map(({ ago }) => ago)).toEqual([5_000, 3_000]);
  });
});

describe("what leaves the browser", () => {
  it("drops the query, except campaign tags, before anything is sent", () => {
    at("/welcome?token=abc&email=ada%40acme.example&utm_source=news");
    start(options);
    vi.advanceTimersByTime(5_000);
    expect(events()[0].path).toBe("/welcome?utm_source=news");
  });

  it("takes emails and long tokens out of the path", () => {
    at("/users/ada%40acme.example/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    start(options);
    vi.advanceTimersByTime(5_000);
    expect(events()[0].path).toBe("/users/[email]/[token]");
  });

  it("never carries a fragment", () => {
    at("/a#access_token=secret");
    start(options);
    vi.advanceTimersByTime(5_000);
    expect(JSON.stringify(events())).not.toContain("secret");
  });
});

describe("batches", () => {
  it("go together: a page and what happened right after, in one request", () => {
    start(options);
    track("a");
    track("b", { plan: "pro" });
    vi.advanceTimersByTime(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events().map(({ kind, name }) => [kind, name])).toEqual([["page", undefined], ["event", "a"], ["event", "b"]]);
    expect(events()[2].props).toEqual({ plan: "pro" });
  });

  it("go at ten events, without waiting", () => {
    start(options);
    for (let count = 0; count < 9; count += 1) track("a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetched()[0].events).toHaveLength(10);
  });

  it("use a beacon on page hide, as plain text, and leave nothing waiting", () => {
    start(options);
    track("a");
    hide();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe(ENDPOINT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconed()[0].events).toHaveLength(2);
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("use a beacon when the tab is hidden", () => {
    start(options);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    expect(beacon).toHaveBeenCalled();
  });

  it("fall back on fetch when a beacon can't leave", () => {
    beacon.mockReturnValueOnce(false);
    start(options);
    hide();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("send nothing on page hide when nothing's waiting", () => {
    start(options);
    hide();
    beacon.mockClear();
    hide();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("hold what a child recorded before the component started", () => {
    track("early");
    vi.advanceTimersByTime(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
    start(options);
    vi.advanceTimersByTime(5_000);
    expect(events().map(({ name }) => name)).toContain("early");
  });

  it("carry web vitals", () => {
    start(options);
    recordVital("LCP", 1234);
    vi.advanceTimersByTime(5_000);
    expect(events()[1]).toMatchObject({ kind: "vital", name: "LCP", value: 1234 });
  });
});

describe("a collector that's down", () => {
  it("disturbs nothing: a rejected request goes unnoticed", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    start(options);
    vi.advanceTimersByTime(5_000);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("disturbs nothing: not even fetch throwing, or the beacon", () => {
    fetchMock.mockImplementationOnce(() => {
      throw new Error("Blocked");
    });
    beacon.mockImplementationOnce(() => {
      throw new Error("Blocked");
    });
    start(options);
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    track("a");
    expect(() => hide()).not.toThrow();
  });

  it("disturbs nothing when storage is refused", () => {
    const refused = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Refused");
    });
    start(options);
    expect(() => identify("user_1")).not.toThrow();
    refused.mockRestore();
  });

  it("doesn't grow without end while nothing can leave", () => {
    setConsent(false);
    start(options);
    for (let count = 0; count < 200; count += 1) track("a");
    setConsent(true);
    expect(fetched()[0].events.length).toBeLessThanOrEqual(50);
  });
});

describe("nothing kept before identify", () => {
  it("sets no cookie and stores nothing, however much is counted", () => {
    start(options);
    track("a", { x: 1 });
    window.history.pushState({}, "", "/b");
    vi.advanceTimersByTime(5_000);
    hide();
    expect(document.cookie).toBe("");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("identify", () => {
  it("names who this is from here on, what the site says about them, and only then keeps something", () => {
    start(options);
    expect(localStorage.length).toBe(0);
    identify("user_1", { plan: "pro" });
    track("a");
    vi.advanceTimersByTime(5_000);
    const [page, who, done] = events();
    expect(page.userId).toBeUndefined();
    expect(who).toMatchObject({ kind: "identify", userId: "user_1", traits: { plan: "pro" } });
    expect(done).toMatchObject({ name: "a", userId: "user_1" });
    expect(localStorage.getItem("trailic.user")).toBe("user_1");
    expect(document.cookie).toBe("");
  });

  it("remembers them on the next page load", () => {
    localStorage.setItem("trailic.user", "user_1");
    start(options);
    vi.advanceTimersByTime(5_000);
    expect(events()[0].userId).toBe("user_1");
  });

  it("forgets them on reset, and what comes next is anonymous", () => {
    start(options);
    identify("user_1");
    reset();
    track("a");
    vi.advanceTimersByTime(5_000);
    expect(localStorage.getItem("trailic.user")).toBeNull();
    expect(events().at(-1)?.userId).toBeUndefined();
  });
});

describe("consent", () => {
  it("holds everything back until the visitor agrees, then it all leaves", () => {
    setConsent(false);
    start(options);
    track("a");
    vi.advanceTimersByTime(60_000);
    hide();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    setConsent(true);
    expect(events().map(({ kind }) => kind)).toEqual(["page", "event"]);
  });

  it("keeps nothing in the browser until then, even after identify", () => {
    setConsent(false);
    start(options);
    identify("user_1");
    expect(localStorage.length).toBe(0);
    setConsent(true);
    expect(localStorage.getItem("trailic.user")).toBe("user_1");
  });

  it("removes what was kept when it's withdrawn", () => {
    start(options);
    identify("user_1");
    setConsent(false);
    expect(localStorage.length).toBe(0);
  });

  it("reads nothing remembered while refused", () => {
    localStorage.setItem("trailic.user", "user_1");
    setConsent(false);
    start(options);
    expect(localStorage.length).toBe(0);
    setConsent(true);
    vi.advanceTimersByTime(5_000);
    expect(events()[0].userId).toBeUndefined();
  });
});

describe("Do Not Track and Global Privacy Control", () => {
  const withSignals = { ...options, respectPrivacySignals: true };

  it("are ignored unless the site opts in", () => {
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    start(options);
    vi.advanceTimersByTime(5_000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it.each([
    ["Do Not Track", "doNotTrack", "1"],
    ["Global Privacy Control", "globalPrivacyControl", true],
  ])("%s stops everything when the site opts in", (_, property, value) => {
    Object.defineProperty(navigator, property, { configurable: true, value });
    start(withSignals);
    track("a");
    identify("user_1");
    vi.advanceTimersByTime(60_000);
    hide();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("also stops what a child recorded before the component started", () => {
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    track("early");
    start(withSignals);
    vi.advanceTimersByTime(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("let everything through when the browser doesn't say so", () => {
    start(withSignals);
    vi.advanceTimersByTime(5_000);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("objecting", () => {
  it("keeps nothing in the browser until the visitor chooses", () => {
    start(options);
    track("a");
    expect(isOptedOut()).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("sends nothing more, and drops what was waiting", () => {
    start(options);
    track("a");
    optOut();
    track("b");
    at("/next");
    vi.advanceTimersByTime(60_000);
    hide();
    expect(events()).toEqual([]);
  });

  it("lasts past this page: a new one sends nothing either", () => {
    start(options);
    optOut();
    expect(localStorage.getItem("trailic.optOut")).toBe("1");
    forgetEverything();
    start(options);
    track("a");
    vi.advanceTimersByTime(60_000);
    expect(isOptedOut()).toBe(true);
    expect(events()).toEqual([]);
  });

  it("forgets who they were, and keeps nothing from identify afterwards", () => {
    start(options);
    identify("user_1");
    optOut();
    expect(localStorage.getItem("trailic.user")).toBeNull();
    identify("user_2");
    expect(localStorage.getItem("trailic.user")).toBeNull();
  });

  it("can be taken back, which removes what the browser kept", () => {
    start(options);
    optOut();
    optIn();
    expect(isOptedOut()).toBe(false);
    expect(localStorage.length).toBe(0);
    track("a");
    vi.advanceTimersByTime(60_000);
    expect(events().map(({ name }) => name)).toEqual(["a"]);
  });

  it("still holds for the page in a browser that keeps nothing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Refused");
    });
    start(options);
    optOut();
    track("a");
    vi.advanceTimersByTime(60_000);
    expect(isOptedOut()).toBe(true);
    expect(events()).toEqual([]);
    vi.restoreAllMocks();
  });
});
