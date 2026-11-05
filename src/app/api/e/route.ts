import { allowedOriginFor, collect, newLimits, type CollectAnswer, type CollectorPorts, type IncomingRequest } from "@/application/collect";
import { LARGEST_BODY_BYTES } from "@/domain/collected";
import { eventBuffer } from "@/infrastructure/buffer";
import { directoryForCollector } from "@/infrastructure/collector/directory";
import { env } from "@/infrastructure/env";

const limits = newLimits();

const portsOf = (secret: string): CollectorPorts => ({ secret, buffer: eventBuffer(), directory: directoryForCollector, limits, now: () => new Date() });

const firstAddress = (header: string | null) => header?.split(",")[0]?.trim() ?? "";

/** The body, read no further than the limit: a length header can lie, or be missing. */
async function bodyWithinLimit(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > LARGEST_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.length;
    if (size > LARGEST_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

/** The request as the collector sees it. The address is read here and handed over for the hash; nothing below this keeps it. */
function incoming(request: Request, body: string): IncomingRequest {
  const { headers } = request;
  const relayKey = headers.get("x-trailic-relay");
  return {
    body,
    origin: headers.get("origin"),
    userAgent: headers.get("user-agent"),
    address: firstAddress(headers.get("x-forwarded-for")) || (headers.get("x-real-ip") ?? ""),
    country: headers.get("x-vercel-ip-country"),
    prefetch: /prefetch|prerender/i.test(`${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""}`),
    relay: relayKey ? { key: relayKey, address: headers.get("x-trailic-address") ?? "", country: headers.get("x-trailic-country") || null } : null,
  };
}

const corsHeaders = (origin: string | null): HeadersInit => (origin ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" });

function answered({ status, allowOrigin, retryAfter }: CollectAnswer): Response {
  return new Response(null, { status, headers: { ...corsHeaders(allowOrigin), "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) } });
}

/** Where pages send what happened. A public address, for a public key: see application/collect for who gets in. */
export async function POST(request: Request) {
  const body = await bodyWithinLimit(request);
  if (body === null) return new Response(null, { status: 413 });
  const secret = env().TRAILIC_SECRET;
  if (!secret) return new Response(null, { status: 503 });
  return answered(await collect(portsOf(secret), incoming(request, body)));
}

/**
 * Only for clients that post JSON: the library sends plain text, and costs no preflight. A preflight
 * has no body, so such a client names its key in the address, as ?key=.
 */
export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  const secret = env().TRAILIC_SECRET;
  const allowed = secret ? await allowedOriginFor({ secret, directory: directoryForCollector }, new URL(request.url).searchParams.get("key"), origin) : null;
  return new Response(null, { status: 204, headers: { ...corsHeaders(allowed), "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
}
