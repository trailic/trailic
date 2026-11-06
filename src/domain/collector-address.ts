/**
 * A collector can have an address of its own, so that what a site's pages name says only that it uses
 * Trailic and nothing about whose instance it is. So that holds for anyone who opens that address too,
 * nothing but the collector answers there: no sign-in page, no redirect, no asset of the app's.
 */

/** Answers 404 to everything, with nothing in the body: where all but the collector goes, on that address. */
export const NOTHING_HERE = "/api/not-found";

export const hostOfCollector = (collectorUrl: string | undefined) => (collectorUrl ? new URL(collectorUrl).host : null);

/** For next.config's rewrites, ahead of every file and page. */
export const collectorOnly = (host: string | null) => (host ? [{ source: "/((?!api/e$).*)", has: [{ type: "host" as const, value: host }], destination: NOTHING_HERE }] : []);

/** For a redirect that would otherwise run first, and say something about the app. */
export const notOnTheCollector = (host: string | null) => (host ? { missing: [{ type: "host" as const, value: host }] } : {});
