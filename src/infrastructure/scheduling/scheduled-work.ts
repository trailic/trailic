import { revalidateTag } from "next/cache";

/**
 * What's known without asking the database: whether there are sites, and which. It lives in the
 * platform's cache, so a job with nothing to do and a collector with a page view to take don't wake a
 * database that bills by the hour it is awake. Whatever changes a site clears it.
 */
export const SITES_TAG = "sites";

/**
 * Clears what's known, so the next reader asks. Next applies it when the request's route returns, so a
 * change has to happen before that. Outside a request (a test, a script) nothing is cached to clear.
 */
export function sitesChanged(): void {
  try {
    revalidateTag(SITES_TAG, { expire: 0 });
  } catch {
    // Only reachable outside a request; at worst what's cached is a day old.
  }
}
