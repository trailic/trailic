"use client";

import { useEffect } from "react";
import { recordVital } from "./core.js";

/** The largest paint so far, the layout shift so far and the slowest interaction: each browser's own measures, sent as the page goes. */
function watchVitals(): () => void {
  const latest = { LCP: 0, CLS: 0, INP: 0 };
  const watch = (type: string, read: (entry: PerformanceEntry & Record<string, unknown>) => void, extra: Record<string, unknown> = {}) => {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => read(entry as PerformanceEntry & Record<string, unknown>)));
      observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    } catch {
      // A browser without this measure just doesn't report it.
    }
  };
  watch("largest-contentful-paint", (entry) => void (latest.LCP = entry.startTime));
  watch("layout-shift", (entry) => void (latest.CLS += entry.hadRecentInput ? 0 : (entry.value as number)));
  watch("event", (entry) => void (latest.INP = Math.max(latest.INP, entry.duration)), { durationThreshold: 40 });
  const report = () => {
    if (document.visibilityState !== "hidden") return;
    for (const [name, value] of Object.entries(latest)) if (value > 0) recordVital(name, Math.round(value * 1000) / 1000);
    latest.LCP = latest.CLS = latest.INP = 0;
  };
  addEventListener("visibilitychange", report, { capture: true });
  return () => removeEventListener("visibilitychange", report, { capture: true });
}

/** Optional, and a separate import so a site that doesn't want it doesn't carry it. */
export function TrailicVitals(): null {
  useEffect(watchVitals, []);
  return null;
}
