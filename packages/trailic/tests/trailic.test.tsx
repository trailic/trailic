import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetEverything } from "../src/core.js";
import { identify, reset, setConsent, track, Trailic } from "../src/index.js";
import { TrailicVitals } from "../src/vitals.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
let root: Root | undefined;

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetEverything();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  window.history.replaceState({}, "", "/page");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sent = () => fetchMock.mock.calls.flatMap((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).events as { kind: string; path: string }[]);

describe("<Trailic>", () => {
  it("renders nothing, on the server or in the browser", async () => {
    expect(renderToString(<Trailic siteKey="k" endpoint="/e" />)).toBe("");
    expect((await render(<Trailic siteKey="k" endpoint="/e" />)).innerHTML).toBe("");
  });

  it("does nothing while rendering on the server", () => {
    renderToString(<Trailic siteKey="k" endpoint="/e" />);
    vi.advanceTimersByTime(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts the page once, even mounted twice by strict mode", async () => {
    const { StrictMode } = await import("react");
    await render(
      <StrictMode>
        <Trailic siteKey="k" endpoint="/e" />
      </StrictMode>,
    );
    vi.advanceTimersByTime(5_000);
    expect(sent().filter(({ kind }) => kind === "page")).toHaveLength(1);
  });

  it("renders its page the same when the collector is down", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const container = await render(
      <div>
        <p>Content</p>
        <Trailic siteKey="k" endpoint="/e" />
      </div>,
    );
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(container.textContent).toBe("Content");
  });

  it("holds everything back while consent is false, and sends when it turns true", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root?.render(<Trailic siteKey="k" endpoint="/e" consent={false} />));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root?.render(<Trailic siteKey="k" endpoint="/e" consent />));
    expect(sent().map(({ kind }) => kind)).toEqual(["page"]);
  });

  it("offers the rest from the same import", () => {
    expect([typeof track, typeof identify, typeof reset, typeof setConsent]).toEqual(["function", "function", "function", "function"]);
  });
});

describe("<TrailicVitals>", () => {
  type Entry = { startTime?: number; duration?: number; value?: number; hadRecentInput?: boolean };
  const observers = new Map<string, (entries: Entry[]) => void>();

  beforeEach(() => {
    observers.clear();
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(private readonly callback: (list: { getEntries: () => Entry[] }) => void) {}
        observe({ type }: { type: string }) {
          observers.set(type, (entries) => this.callback({ getEntries: () => entries }));
        }
      },
    );
  });

  const hideTab = () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  };

  it("reports what the browser measured when the tab goes away, ignoring shifts after input", async () => {
    await render(
      <>
        <Trailic siteKey="k" endpoint="/e" />
        <TrailicVitals />
      </>,
    );
    observers.get("largest-contentful-paint")?.([{ startTime: 1200 }]);
    observers.get("layout-shift")?.([{ value: 0.1, hadRecentInput: false }, { value: 0.5, hadRecentInput: true }]);
    observers.get("event")?.([{ duration: 80 }, { duration: 200 }, { duration: 40 }]);
    hideTab();
    await act(async () => vi.advanceTimersByTime(5_000));
    const vitals = sent().filter(({ kind }) => kind === "vital") as unknown as { name: string; value: number }[];
    expect(Object.fromEntries(vitals.map(({ name, value }) => [name, value]))).toEqual({ LCP: 1200, CLS: 0.1, INP: 200 });
  });

  it("does without what a browser doesn't measure", async () => {
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        observe() {
          throw new Error("Unsupported");
        }
      },
    );
    await expect(render(<TrailicVitals />)).resolves.toBeDefined();
  });
});

describe("<Trailic> and setConsent", () => {
  it("leaves alone what the site said, when it's given no consent prop", async () => {
    setConsent(false);
    await render(<Trailic siteKey="k" endpoint="/e" />);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(fetchMock).not.toHaveBeenCalled();
    setConsent(true);
    expect(sent().map(({ kind }) => kind)).toEqual(["page"]);
  });
});
