/** Addresses read the same way however they were written. What each use keeps of one is its own business. */

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV6_GROUPS = 8;
/** How much of an IPv6 address is one customer's: a single line gets billions of the addresses after this. */
const IPV6_NETWORK_GROUPS = 4;

export type ReadAddress = { ipv4: string } | { ipv6: string[] };

const groupsOf = (text: string | undefined) => (text ? text.split(":") : []);

function ipv6Groups(bare: string): string[] {
  const [before, after] = bare.split("::");
  const [head, tail] = [groupsOf(before), groupsOf(after)];
  const gap = Array<string>(Math.max(0, IPV6_GROUPS - head.length - tail.length)).fill("0");
  return [...head, ...gap, ...tail].map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
}

/** The address, or null when it isn't one and so says nothing about anyone. */
export function readAddress(address: string): ReadAddress | null {
  const bare = address.trim().split("%")[0];
  const ipv4 = MAPPED_IPV4.exec(bare)?.[1] ?? bare;
  if (IPV4.test(ipv4)) return { ipv4 };
  return bare.includes(":") ? { ipv6: ipv6Groups(bare) } : null;
}

export const ipv6Prefix = (groups: readonly string[], kept: number) => `${groups.slice(0, kept).join(":")}::`;

/**
 * What a sender is counted as: a whole IPv4 address, or an IPv6 address's network, since changing the
 * rest of that is free. Nothing when it isn't an address.
 */
export function senderNetwork(address: string): string {
  const read = readAddress(address);
  if (!read) return "";
  return "ipv4" in read ? read.ipv4 : ipv6Prefix(read.ipv6, IPV6_NETWORK_GROUPS);
}
