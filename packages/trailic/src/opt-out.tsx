"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { isOptedOut, optIn, optOut } from "./core.js";

export interface TrailicOptOutProps {
  /** What it says while this visitor is being measured. */
  stop: string;
  /** What it says once they've objected. */
  resume: string;
  /** Leave it out for something that reads as a link in the page's own text. */
  className?: string;
}

const READS_AS_A_LINK: CSSProperties = { background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", textDecoration: "underline", cursor: "pointer" };

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function choose(objects: boolean): void {
  if (objects) optOut();
  else optIn();
  for (const listener of listeners) listener();
}

/**
 * The way to object, for a privacy page. It starts as "stop" whatever the browser holds, since the
 * server can't know, and says what's true as soon as it has run.
 */
export function TrailicOptOut({ stop, resume, className }: TrailicOptOutProps) {
  const objected = useSyncExternalStore(subscribe, isOptedOut, () => false);
  return (
    <button type="button" onClick={() => choose(!objected)} className={className} style={className ? undefined : READS_AS_A_LINK}>
      {objected ? resume : stop}
    </button>
  );
}
