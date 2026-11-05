import { createHmac, randomBytes } from "node:crypto";
import { sameSecret } from "./secrets";

/**
 * A site's public key says which site it is for and proves this instance issued it, so the collector
 * can turn a forged key away without asking the database, and can still accept a real one while the
 * database sleeps or is down. It is public: it sits in every page of the site.
 */

const PREFIX = "site_";
const ID_LENGTH = 22;
const NONCE_LENGTH = 8;
const SIGNATURE_LENGTH = 22;
const KEY_PURPOSE = "site-key:";
const RELAY_PURPOSE = "relay-key:";

const signed = (secret: string, purpose: string, text: string) => createHmac("sha256", secret).update(`${purpose}${text}`).digest().subarray(0, 16).toString("base64url");

const packedId = (siteId: string) => Buffer.from(siteId.replaceAll("-", ""), "hex").toString("base64url");

function unpackedId(packed: string): string {
  const hex = Buffer.from(packed, "base64url").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A new key for a site. The random part means a replaced key stops working, while the site stays the same. */
export function mintSiteKey(siteId: string, secret: string): string {
  const body = `${packedId(siteId)}${randomBytes(6).toString("base64url")}`;
  return `${PREFIX}${body}${signed(secret, KEY_PURPOSE, body)}`;
}

/** The site a key is for, or null when this instance didn't issue it. Reads nothing but the key. */
export function siteIdOfKey(key: unknown, secret: string): string | null {
  if (typeof key !== "string" || !key.startsWith(PREFIX) || key.length !== PREFIX.length + ID_LENGTH + NONCE_LENGTH + SIGNATURE_LENGTH) return null;
  const body = key.slice(PREFIX.length, -SIGNATURE_LENGTH);
  if (!sameSecret(key.slice(-SIGNATURE_LENGTH), signed(secret, KEY_PURPOSE, body))) return null;
  return unpackedId(body.slice(0, ID_LENGTH));
}

/** What a relay on a site's own domain proves itself with, when it passes on the visitor's address. Derived, so checking it reads nothing. */
export const relayKeyOf = (siteId: string, secret: string) => `relay_${signed(secret, RELAY_PURPOSE, siteId)}`;
