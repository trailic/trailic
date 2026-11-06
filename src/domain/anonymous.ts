/** What anonymous mode changes about what's kept: how an address is hashed, and which pages count at all. The address itself never goes further than the hash. */

const IPV4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/;
const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV6_GROUPS_KEPT = 3;

/** Where people sign in or manage their account: never counted, since what someone does there is about them rather than about the site's pages. */
export const SIGN_IN_AREAS = ["login", "signin", "sign-in", "signup", "sign-up", "register", "logout", "auth", "reset-password", "forgot-password", "admin", "account", "dashboard", "settings"] as const;

const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/** Whether a path is in one of those areas, after any leading locale. Whole segments only: /admin-tools-guide and /blog/login-attacks are ordinary pages. */
export function isSignInArea(path: string): boolean {
  const segments = path.split(/[?#]/)[0].split("/").filter(Boolean);
  const area = segments[0] && LOCALE_SEGMENT.test(segments[0]) ? segments[1] : segments[0];
  return (SIGN_IN_AREAS as readonly string[]).includes(area?.toLowerCase());
}

/** IPv4 to its /24 and IPv6 to its /48, in one spelling however it was written. Anything else says nothing about anyone, so it becomes nothing. */
export function shortenedAddress(address: string): string {
  const bare = address.trim().split("%")[0];
  const ipv4 = IPV4.exec(MAPPED_IPV4.exec(bare)?.[1] ?? bare);
  if (ipv4) return `${ipv4[1]}.0`;
  if (!bare.includes(":")) return "";
  const [beforeGap] = bare.split("::");
  const groups = beforeGap ? beforeGap.split(":") : [];
  const kept = [...groups, ...Array<string>(IPV6_GROUPS_KEPT).fill("0")].slice(0, IPV6_GROUPS_KEPT);
  return `${kept.map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::`;
}
