import { cleanPagePath } from "./clean-url.js";
import type { EventKind, Traits, WireBatch, WireEvent } from "./wire.js";

/**
 * What runs in the browser: a small queue, sent in batches. Nothing here may disturb the page, so
 * every call swallows its own failures, and nothing is written anywhere until the site calls identify.
 */

export interface StartOptions {
  siteKey: string;
  /** The collector: its address, or a path on this domain (see trailic/next). */
  endpoint: string;
  /** Send nothing when the browser says Do Not Track or Global Privacy Control. Off by default. */
  respectPrivacySignals?: boolean;
}

type Queued = WireEvent & { at: number };

const USER_STORAGE_KEY = "trailic.user";
const FLUSH_AFTER_MS = 5_000;
const FLUSH_AT_EVENTS = 10;
/** What's held while nothing can leave: a page that never gets consent can't grow without end. */
const LONGEST_QUEUE = 50;

let options: StartOptions | undefined;
let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let consent = true;
let userId: string | undefined;
let lastPath: string | undefined;
let referrerSent = false;
let historyWatched = false;
let listening = false;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const quietly = (work: () => void) => {
  try {
    work();
  } catch {
    // Measuring must never be why a page breaks.
  }
};

function saysNotToTrack(): boolean {
  const browser = navigator as Navigator & { globalPrivacyControl?: boolean };
  return browser.doNotTrack === "1" || browser.globalPrivacyControl === true;
}

const mayQueue = () => !options?.respectPrivacySignals || !saysNotToTrack();

/** Sends what's waiting. On page hide only a beacon can be trusted to leave; both go as plain text, so no preflight. */
function flush(onPageHide = false): void {
  clearTimeout(timer);
  timer = undefined;
  if (!options || !consent || queue.length === 0) return;
  const { siteKey, endpoint } = options;
  const now = Date.now();
  const batch: WireBatch = { key: siteKey, events: queue.splice(0, queue.length).map(({ at, ...event }) => ({ ...event, ago: now - at })) };
  const body = JSON.stringify(batch);
  quietly(() => {
    if (onPageHide && navigator.sendBeacon?.(endpoint, body)) return;
    void fetch(endpoint, { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => {});
  });
}

const currentPath = () => cleanPagePath(location.pathname + location.search);

function enqueue(kind: EventKind, details: Omit<WireEvent, "kind">): void {
  quietly(() => {
    if (!mayQueue()) return;
    queue.push({ path: currentPath(), ...details, kind, at: Date.now(), ...(userId ? { userId } : {}) });
    if (queue.length > LONGEST_QUEUE) queue.shift();
    if (queue.length >= FLUSH_AT_EVENTS) flush();
    else timer ??= setTimeout(flush, FLUSH_AFTER_MS);
  });
}

/** Counts a page when the cleaned address changes: a query that's dropped anyway, or Next replacing its own state, isn't a new page. */
function notePage(): void {
  quietly(() => {
    const path = currentPath();
    if (path === lastPath) return;
    lastPath = path;
    const referrer = referrerSent ? "" : document.referrer;
    referrerSent = true;
    enqueue("page", referrer ? { path, referrer } : { path });
  });
}

/** Next's router moves with the history API, and says nothing else a library without Next could hear. */
function watchHistory(): void {
  if (historyWatched) return;
  historyWatched = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      if (listening) notePage();
      return result;
    };
  }
  addEventListener("popstate", () => listening && notePage());
  addEventListener("pagehide", () => flush(true));
  addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush(true));
}

/** Starts counting this page and the next. The answer stops it, for React's effect. */
export function start(next: StartOptions): () => void {
  options = next;
  // What a child's effect recorded before this one ran, on a browser that says not to.
  if (!mayQueue()) queue = [];
  quietly(() => {
    if (consent) userId ??= storage()?.getItem(USER_STORAGE_KEY) ?? undefined;
    watchHistory();
    listening = true;
    notePage();
    if (queue.length > 0) timer ??= setTimeout(flush, FLUSH_AFTER_MS);
  });
  return () => {
    listening = false;
  };
}

/** Records a custom event. Numbers, strings and booleans only: anything that names a person is the site's choice to send. */
export function track(name: string, props?: Traits): void {
  enqueue("event", props ? { name, props } : { name });
}

/** Says who this visitor is, typically after sign-in. From here on, and only from here on, something is kept in the browser. */
export function identify(id: string, traits?: Traits): void {
  userId = id;
  quietly(() => {
    if (consent && mayQueue()) storage()?.setItem(USER_STORAGE_KEY, id);
  });
  enqueue("identify", traits ? { traits } : {});
}

/** Forgets who this visitor is, typically at sign-out, and removes what identify kept. */
export function reset(): void {
  userId = undefined;
  quietly(() => storage()?.removeItem(USER_STORAGE_KEY));
}

/**
 * Whether the visitor agreed. Refused, what's waiting stays in memory until they agree, or the page
 * goes; and anything kept from an earlier agreement is removed. Agreed, it all leaves.
 */
export function setConsent(granted: boolean): void {
  consent = granted;
  quietly(() => {
    if (!granted) {
      storage()?.removeItem(USER_STORAGE_KEY);
      return;
    }
    if (userId) storage()?.setItem(USER_STORAGE_KEY, userId);
    else userId = storage()?.getItem(USER_STORAGE_KEY) ?? undefined;
    if (queue.length > 0) flush();
  });
}

/** A web vital, for trailic/vitals. */
export function recordVital(name: string, value: number): void {
  enqueue("vital", { name, value });
}

/** Back to how a page starts. For tests: a page has no use for it. */
export function forgetEverything(): void {
  clearTimeout(timer);
  options = undefined;
  queue = [];
  timer = undefined;
  consent = true;
  userId = undefined;
  lastPath = undefined;
  referrerSent = false;
  listening = false;
}
