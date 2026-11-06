/** What anonymous mode does to an address before it goes into the day's hash. The address itself never goes further than that. */

const IPV4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/;
const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV6_GROUPS_KEPT = 3;

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
