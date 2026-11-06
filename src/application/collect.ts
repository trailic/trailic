import { isSignInArea, shortenedAddress } from "@/domain/anonymous";
import { anonymised, dayOf, happenedAt, LARGEST_BODY_BYTES, pathAndCampaign, referrerHost, WIRE_BATCH, wireEventsOf, type CollectedEvent, type WireEventParsed } from "@/domain/collected";
import { RateWindow } from "@/domain/rate-window";
import { hostAllowed, hostOf } from "@/domain/sites";
import { coarseClient, isBot } from "@/domain/user-agent";
import { relayKeyOf, siteIdOfKey } from "@/infrastructure/crypto/site-key";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import { visitorOf } from "@/infrastructure/crypto/visitor-hash";
import type { EventBuffer } from "./event-buffer";
import type { DirectoryEntry } from "./sites";

/** One visitor's requests in a minute. A page sends a batch every few seconds at the very most. */
export const REQUESTS_PER_VISITOR_MINUTE = 120;
/** One site's requests in a minute, on one server instance: a hundred a second, more than this is built for. */
export const REQUESTS_PER_SITE_MINUTE = 6_000;
const RETRY_AFTER_SECONDS = 60;

export interface CollectorPorts {
  secret: string;
  buffer: EventBuffer;
  /** Every site, or null when that can't be known right now: the database is asleep and the cache is cold, say. */
  directory: (key?: string) => Promise<readonly DirectoryEntry[] | null>;
  limits: { visitors: RateWindow; sites: RateWindow };
  now: () => Date;
}

export const newLimits = (): CollectorPorts["limits"] => ({ visitors: new RateWindow(REQUESTS_PER_VISITOR_MINUTE), sites: new RateWindow(REQUESTS_PER_SITE_MINUTE) });

/** The request, reduced to what the collector reads. The route takes it off the headers; the address goes no further than the hash. */
export interface IncomingRequest {
  body: string;
  origin: string | null;
  userAgent: string | null;
  /** The address the connection came from, or what a proxy says it was. */
  address: string;
  country: string | null;
  /** A browser fetching ahead of time: nobody has seen the page. */
  prefetch: boolean;
  relay: { key: string; address: string; country: string | null } | null;
}

export type CollectAnswer = {
  status: 202 | 400 | 403 | 404 | 413 | 429 | 503;
  /** The origin to allow, when this origin may read the answer. */
  allowOrigin: string | null;
  retryAfter?: number;
  /** How many events were kept. Nothing to report to a visitor: it's for tests and logs. */
  accepted: number;
};

const refusal = (status: CollectAnswer["status"], extra: Partial<CollectAnswer> = {}): CollectAnswer => ({ status, allowOrigin: null, accepted: 0, ...extra });

/** Who really asked: what a relay says, once its key proves it's the site's own, otherwise the connection itself. */
function visitorOrigin(request: IncomingRequest, siteId: string, secret: string): { address: string; country: string | null } {
  const { relay } = request;
  if (relay?.key && sameSecret(relay.key, relayKeyOf(siteId, secret))) return { address: relay.address, country: relay.country };
  return { address: request.address, country: request.country };
}

interface Client {
  visitor: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
}

const NO_CLIENT: Client = { visitor: null, country: null, device: null, browser: null, os: null };

/** What anonymous mode leaves of a batch: no identify, nothing from a sign-in, account or admin area, and nothing that follows someone. */
const leftByAnonymousMode = (events: CollectedEvent[]) => events.filter(({ kind, path }) => kind !== "identify" && !(path && isSignInArea(path))).map(anonymised);

function shapedEvent(event: WireEventParsed, client: Client, receivedAt: Date, originHost: string | null): CollectedEvent {
  return {
    kind: event.kind,
    at: happenedAt(receivedAt, event.ago),
    ...pathAndCampaign(event.path),
    name: event.name ?? null,
    visitor: client.visitor,
    userId: event.userId ?? null,
    referrer: referrerHost(event.referrer, originHost),
    country: client.country,
    device: client.device,
    browser: client.browser,
    os: client.os,
    props: event.props ?? null,
    traits: event.traits ?? null,
    value: event.value ?? null,
  };
}

/** What a page's request carries beyond its events: the day's visitor and a coarse idea of their browser. The address stops here. */
function clientOf(request: IncomingRequest, siteId: string, ports: CollectorPorts, day: string, anonymous: boolean): Client {
  const { address, country } = visitorOrigin(request, siteId, ports.secret);
  const userAgent = request.userAgent as string;
  const valid = country && /^[A-Z]{2}$/.test(country) ? country : null;
  return { visitor: visitorOf({ secret: ports.secret, siteId, day, address: anonymous ? shortenedAddress(address) : address, userAgent }), country: valid, ...coarseClient(userAgent) };
}

const withinLimits = (ports: CollectorPorts, siteId: string, visitor: string | null, now: number) => ports.limits.sites.take(siteId, now) && (visitor === null || ports.limits.visitors.take(visitor, now));

function parsedBody(body: string) {
  try {
    return WIRE_BATCH.safeParse(JSON.parse(body)).data ?? null;
  } catch {
    return null;
  }
}

/** Who may send: a browser from one of the site's domains, or a server, which a browser can't claim to be. Null when it's fine. */
function originRefusal(request: IncomingRequest, entry: DirectoryEntry | undefined, server: boolean): CollectAnswer | null {
  if (server) return request.origin ? refusal(403) : null;
  const host = hostOf(request.origin);
  if (!host) return refusal(403);
  return entry && !hostAllowed(host, entry.allowedDomains) ? refusal(403) : null;
}

/**
 * The whole way in, and an event never touches the database: the key is checked by its signature, the
 * site's domains come from a directory kept in the cache, read from the database about once a day,
 * and the events go to the buffer. Only what the buffer has kept is answered 202. Bots get an ordinary
 * answer, so nothing teaches them to look different.
 */
export async function collect(ports: CollectorPorts, request: IncomingRequest): Promise<CollectAnswer> {
  if (request.body.length > LARGEST_BODY_BYTES) return refusal(413);
  const wire = parsedBody(request.body);
  if (!wire) return refusal(400);
  const siteId = siteIdOfKey(wire.key, ports.secret);
  if (!siteId) return refusal(404);
  const directory = await ports.directory(wire.key);
  const entry = directory?.find(({ key }) => key === wire.key);
  if (directory && !entry) return refusal(404);
  const server = wire.server === true;
  const refused = originRefusal(request, entry, server);
  if (refused) return refused;
  const allowOrigin = request.origin;
  if (!server && (request.prefetch || isBot(request.userAgent))) return { status: 202, allowOrigin, accepted: 0 };
  const receivedAt = ports.now();
  // Nobody able to say what this site asked for: keep the least, since what's kept can't be taken back at the flush.
  const anonymous = entry?.anonymous ?? true;
  const client = server ? NO_CLIENT : clientOf(request, siteId, ports, dayOf(receivedAt), anonymous);
  if (!withinLimits(ports, siteId, client.visitor, receivedAt.getTime())) return refusal(429, { retryAfter: RETRY_AFTER_SECONDS, allowOrigin });
  const originHost = hostOf(request.origin);
  const understood = wireEventsOf(wire.events).filter(({ kind }) => !server || kind === "event");
  if (understood.length === 0) return refusal(400, { allowOrigin });
  const shaped = understood.map((event) => shapedEvent(event, client, receivedAt, originHost));
  const events = anonymous ? leftByAnonymousMode(shaped) : shaped;
  // What anonymous mode drops is answered like a bot: nothing here tells a page it was dropped, and nothing shows in its console.
  if (events.length === 0) return { status: 202, allowOrigin, accepted: 0 };
  try {
    await ports.buffer.append({ id: crypto.randomUUID(), siteId, key: wire.key, originHost, verified: Boolean(entry), events });
    return { status: 202, allowOrigin, accepted: events.length };
  } catch {
    return refusal(503, { retryAfter: RETRY_AFTER_SECONDS, allowOrigin });
  }
}

/** Whether a browser may read answers from this origin, for a preflight: only sites that say so. */
export async function allowedOriginFor(ports: Pick<CollectorPorts, "directory" | "secret">, key: string | null, origin: string | null): Promise<string | null> {
  const host = hostOf(origin);
  if (!key || !host || !siteIdOfKey(key, ports.secret)) return null;
  const entry = (await ports.directory(key))?.find((site) => site.key === key);
  return entry && hostAllowed(host, entry.allowedDomains) ? origin : null;
}
