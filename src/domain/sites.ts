/** A site: what a workspace measures. Pure rules about its domains and how long its raw events stay. */

export const DEFAULT_RETENTION_DAYS = 90;
/** Longer than a buffer can hold a batch (7 days): a late batch must never land on a day whose raw rows are already gone. */
export const SHORTEST_RETENTION_DAYS = 14;
export const LONGEST_RETENTION_DAYS = 730;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The host of what someone typed or an Origin header said: "https://www.acme.example:3000/x" is "www.acme.example". Null when it isn't one. */
export function hostOf(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;
  try {
    const { hostname } = new URL(text.includes("://") ? text : `https://${text}`);
    return HOSTNAME.test(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

export interface ParsedDomains {
  domains: string[];
  invalid: string[];
}

/** Domains typed one per line or separated by commas or spaces, in their plain form, without repeats. */
export function parseDomains(text: string): ParsedDomains {
  const entries = text.split(/[\s,]+/).filter(Boolean);
  const domains = new Set<string>();
  const invalid: string[] = [];
  for (const entry of entries) {
    const host = hostOf(entry);
    if (host) domains.add(host);
    else invalid.push(entry);
  }
  return { domains: [...domains], invalid };
}

/** Whether a page on this host may send to the site: the domain itself or anything under it. */
export const hostAllowed = (host: string, allowed: readonly string[]) => allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));

/** How long raw events stay, within what the app can keep its promises about. */
export function validRetention(days: unknown): number | null {
  const parsed = typeof days === "number" ? days : Number(days);
  return Number.isInteger(parsed) && parsed >= SHORTEST_RETENTION_DAYS && parsed <= LONGEST_RETENTION_DAYS ? parsed : null;
}
