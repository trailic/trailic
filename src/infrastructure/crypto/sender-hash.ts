import { createHmac } from "node:crypto";

/**
 * What a sender is counted by, across every site: an address under a key of its own, derived from the
 * instance's secret. It shares nothing with the visitor hash (no daily salt, no site, no browser), so
 * neither says anything about the other. It stays in a rate window's memory until the next request
 * after its minute, and is never stored, sent or logged.
 */

const KEY_PURPOSE = "sender-limit-key";

const senderKey = (secret: string) => createHmac("sha256", secret).update(KEY_PURPOSE).digest();

export const senderOf = (secret: string, network: string) => createHmac("sha256", senderKey(secret)).update(network).digest("base64url");
