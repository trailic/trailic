import { createHash, createHmac } from "node:crypto";

/**
 * How an anonymous visitor is counted: a hash of their address and browser, salted per day and per
 * site, computed here and never stored with what went into it. Tomorrow the same person is someone
 * else, and two sites can't compare who they saw. The address itself is used for this and then gone.
 */

const SALT_PURPOSE = "visitor-salt:";

/** The salt for a day. Derived from the instance's secret so the collector reads nothing to get it. */
export const dailySalt = (secret: string, day: string) => createHmac("sha256", secret).update(`${SALT_PURPOSE}${day}`).digest("hex");

function asUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface VisitorInput {
  secret: string;
  siteId: string;
  /** YYYY-MM-DD, UTC. */
  day: string;
  address: string;
  userAgent: string;
}

/** The day's visitor, as a uuid: 128 bits of the hash in a column that compares and groups quickly. */
export function visitorOf({ secret, siteId, day, address, userAgent }: VisitorInput): string {
  return asUuid(createHash("sha256").update(`${dailySalt(secret, day)}\n${siteId}\n${address}\n${userAgent}`).digest("hex"));
}
