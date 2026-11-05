import type { Traits, WireBatch } from "./wire.js";

export interface ServerOptions {
  /** Falls back to TRAILIC_SITE_KEY. */
  siteKey?: string;
  /** The collector's address. Falls back to TRAILIC_ENDPOINT. */
  endpoint?: string;
  userId?: string;
  /** How long to wait before giving up, in milliseconds. */
  timeoutMs?: number;
}

const WAIT_MS = 2_000;

/**
 * Records a custom event from a route handler: a payment, an import finished. It says whether the
 * collector took it, and never throws: an event isn't worth failing a request over.
 */
export async function trackServer(name: string, props?: Traits, { siteKey, endpoint, userId, timeoutMs = WAIT_MS }: ServerOptions = {}): Promise<boolean> {
  const key = siteKey ?? process.env.TRAILIC_SITE_KEY;
  const address = endpoint ?? process.env.TRAILIC_ENDPOINT;
  if (!key || !address) return false;
  const batch: WireBatch = { key, server: true, events: [{ kind: "event", name, ...(props ? { props } : {}), ...(userId ? { userId } : {}) }] };
  try {
    const response = await fetch(address, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}
