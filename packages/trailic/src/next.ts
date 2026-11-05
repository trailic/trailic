import { FIRST_PARTY_PATH } from "./wire.js";

/**
 * Collecting through the project's own domain, so a blocker aimed at third parties doesn't see it.
 *
 * The rewrite is one line, but what reaches the collector then comes from the proxy. A collector on
 * Vercel sees the proxy's address and country, because Vercel overwrites X-Forwarded-For on what it
 * receives, and visitors would merge into one. The relay is a route in the project that says who the
 * visitor is, with a key proving it's the site's own. Use the rewrite with a collector you run behind
 * your own proxy, and the relay when the collector is on Vercel too.
 */

export { FIRST_PARTY_PATH };

/** Goes in `rewrites` in next.config. `collector` is the instance's address, and `path` what the component's endpoint says. */
export function trailicRewrite(collector: string, path: string = FIRST_PARTY_PATH): { source: string; destination: string } {
  return { source: path, destination: new URL("/api/e", collector).toString() };
}

export interface RelayOptions {
  /** Falls back to TRAILIC_URL: the instance's address. */
  collector?: string;
  /** Falls back to TRAILIC_RELAY_KEY: shown on the site's page in the app. */
  relayKey?: string;
}

const firstAddress = (header: string | null) => header?.split(",")[0]?.trim() ?? "";

/** The handler for `app/trailic/e/route.ts`: `export const POST = trailicRelay();`. It always answers, whatever became of the event. */
export function trailicRelay({ collector, relayKey }: RelayOptions = {}): (request: Request) => Promise<Response> {
  return async (request) => {
    const address = collector ?? process.env.TRAILIC_URL;
    const key = relayKey ?? process.env.TRAILIC_RELAY_KEY;
    if (!address || !key) return new Response(null, { status: 503 });
    const { headers } = request;
    try {
      const answer = await fetch(new URL("/api/e", address), {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "user-agent": headers.get("user-agent") ?? "",
          origin: headers.get("origin") ?? "",
          "x-trailic-relay": key,
          "x-trailic-address": firstAddress(headers.get("x-forwarded-for")) || (headers.get("x-real-ip") ?? ""),
          "x-trailic-country": headers.get("x-vercel-ip-country") ?? "",
        },
        body: await request.text(),
        signal: AbortSignal.timeout(2_000),
      });
      return new Response(null, { status: answer.status });
    } catch {
      return new Response(null, { status: 502 });
    }
  };
}
