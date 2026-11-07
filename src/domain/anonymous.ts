import { ipv6Prefix, readAddress } from "./addresses";

/** What anonymous mode changes about what's kept: how an address is hashed, and which pages count at all. The address itself never goes further than the hash. */

const IPV6_GROUPS_KEPT = 3;

/**
 * Where people sign in, manage their account or have a page of their own: never counted, since what's
 * there is about them rather than the site's pages, and a path like /u/someone would store their name.
 */
export const PERSONAL_AREAS = ["login", "signin", "sign-in", "signup", "sign-up", "register", "logout", "auth", "reset-password", "forgot-password", "admin", "account", "dashboard", "settings", "u", "user", "users", "profile", "profil", "me", "onboarding", "favorites", "portal"] as const;

const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

const namesAnArea = (segment: string | undefined) => (PERSONAL_AREAS as readonly string[]).includes(segment?.toLowerCase() ?? "");

/**
 * Whether a path is in one of those areas, after any leading locale. Whole segments only:
 * /admin-tools-guide and /blog/login-attacks are ordinary pages. The area is looked for first, since
 * /me is two letters and would otherwise pass for a locale.
 */
export function isPersonalArea(path: string): boolean {
  const [first, second] = path.split(/[?#]/)[0].split("/").filter(Boolean);
  return namesAnArea(first) || (first !== undefined && LOCALE_SEGMENT.test(first) && namesAnArea(second));
}

/** IPv4 to its /24 and IPv6 to its /48, in one spelling however it was written. Anything else says nothing about anyone, so it becomes nothing. */
export function shortenedAddress(address: string): string {
  const read = readAddress(address);
  if (!read) return "";
  return "ipv4" in read ? read.ipv4.replace(/\.\d+$/, ".0") : ipv6Prefix(read.ipv6, IPV6_GROUPS_KEPT);
}
