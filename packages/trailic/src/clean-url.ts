/**
 * What's left of an address before it leaves the browser, and again when it reaches the collector:
 * the path, and the campaign tags. Everything else in a query can hold someone's address or a reset
 * token, and rarely says anything about the page. Shared by the library and the app so they can't
 * disagree.
 */

const EMAIL = /[^/@\s]+@[^/@\s]+\.[^/@\s]+/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_RUN = /[A-Za-z0-9]{20,}/g;

export const EMAIL_PLACEHOLDER = "[email]";
export const TOKEN_PLACEHOLDER = "[token]";

/** A long run of letters and digits, with digits or mixed case in it. A long slug is words, and stays. */
function holdsToken(text: string): boolean {
  if (UUID.test(text)) return true;
  return (text.match(LONG_RUN) ?? []).some((run) => /\d/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run)));
}

function cleanSegment(segment: string): string {
  const readable = segment.replace(/%40/gi, "@");
  if (EMAIL.test(readable)) return EMAIL_PLACEHOLDER;
  return holdsToken(readable) ? TOKEN_PLACEHOLDER : segment;
}

function keptQuery(query: string): string {
  return query
    .split("&")
    .filter((pair) => /^utm_[a-z]+=./i.test(pair) && !EMAIL.test(pair.replace(/%40/gi, "@")) && !holdsToken(pair.slice(pair.indexOf("=") + 1)))
    .join("&");
}

/** "/reset/ada%40acme.example?token=x&utm_source=news#top" becomes "/reset/[email]?utm_source=news". */
export function cleanPagePath(raw: string): string {
  const withoutFragment = raw.split("#")[0];
  const queryAt = withoutFragment.indexOf("?");
  const path = queryAt < 0 ? withoutFragment : withoutFragment.slice(0, queryAt);
  const query = queryAt < 0 ? "" : keptQuery(withoutFragment.slice(queryAt + 1));
  const cleaned = path.split("/").map(cleanSegment).join("/") || "/";
  return query ? `${cleaned}?${query}` : cleaned;
}
