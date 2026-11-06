import { z } from "zod";
import { cleanPagePath } from "../../packages/trailic/src/clean-url";
import { hostOf } from "./sites";

/**
 * What reaches the collector, and what it keeps of it. Whatever the library already cleaned is
 * cleaned again here, since anyone can post anything to a public address.
 */

export const LARGEST_BODY_BYTES = 32_768;
export const MOST_EVENTS_IN_A_BATCH = 20;
/** How far back a visitor's browser may place an event: it may have been offline, not for long. */
const LONGEST_AGO_MS = 3_600_000;
const LONGEST_PATH = 512;

const SCALAR = z.union([z.string().max(256), z.number(), z.boolean()]);
const smallRecord = (keys: number) =>
  z
    .record(z.string().max(40), SCALAR)
    .refine((record) => Object.keys(record).length <= keys, "Too many keys.")
    .optional();

const WIRE_EVENT = z.object({
  kind: z.enum(["page", "event", "identify", "vital"]),
  ago: z.number().min(0).optional(),
  path: z.string().max(4096).startsWith("/").optional(),
  referrer: z.string().max(2048).optional(),
  name: z.string().min(1).max(64).optional(),
  props: smallRecord(16),
  value: z.number().optional(),
  userId: z.string().min(1).max(128).optional(),
  traits: smallRecord(32),
});

export type WireEventParsed = z.infer<typeof WIRE_EVENT>;

export const WIRE_BATCH = z.object({ key: z.string().max(128), server: z.boolean().optional(), events: z.array(z.unknown()).min(1).max(MOST_EVENTS_IN_A_BATCH) });

/** Only the events that make sense: one bad one shouldn't cost a visitor the rest of their batch. */
export function wireEventsOf(events: readonly unknown[]): WireEventParsed[] {
  return events.flatMap((event) => {
    const parsed = WIRE_EVENT.safeParse(event);
    return parsed.success && eventIsComplete(parsed.data) ? [parsed.data] : [];
  });
}

function eventIsComplete({ kind, path, name, value, userId }: WireEventParsed): boolean {
  if (kind === "page") return Boolean(path);
  if (kind === "event") return Boolean(name);
  if (kind === "identify") return Boolean(userId);
  return Boolean(name) && typeof value === "number";
}

export const COLLECTED_EVENT = z.object({
  kind: z.enum(["page", "event", "identify", "vital"]),
  at: z.iso.datetime(),
  path: z.string().nullable(),
  name: z.string().nullable(),
  // A hash in a uuid's shape, so not any version of one.
  visitor: z.guid().nullable(),
  userId: z.string().nullable(),
  referrer: z.string().nullable(),
  utmSource: z.string().nullable(),
  utmMedium: z.string().nullable(),
  utmCampaign: z.string().nullable(),
  utmTerm: z.string().nullable(),
  utmContent: z.string().nullable(),
  country: z.string().nullable(),
  device: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  props: z.record(z.string(), SCALAR).nullable(),
  traits: z.record(z.string(), SCALAR).nullable(),
  value: z.number().nullable(),
});

export type CollectedEvent = z.infer<typeof COLLECTED_EVENT>;

/**
 * One request's events, as they wait for the database. Its id is what makes writing it idempotent.
 * `verified` says the collector could read the site's domains when it arrived; when it couldn't, the
 * flush checks them instead, and `originHost` and `key` are what it checks.
 */
export const BUFFERED_BATCH = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  key: z.string(),
  originHost: z.string().nullable(),
  verified: z.boolean(),
  events: z.array(COLLECTED_EVENT).min(1),
});

export type BufferedBatch = z.infer<typeof BUFFERED_BATCH>;

const UTM_COLUMNS = { utm_source: "utmSource", utm_medium: "utmMedium", utm_campaign: "utmCampaign", utm_term: "utmTerm", utm_content: "utmContent" } as const;

type UtmFields = Record<(typeof UTM_COLUMNS)[keyof typeof UTM_COLUMNS], string | null>;

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value.replaceAll("+", " ")).slice(0, 200);
  } catch {
    return value.slice(0, 200);
  }
};

/** The path to count and the campaign it came with. The tags leave the path, or every campaign's page would count as a page of its own. */
export function pathAndCampaign(rawPath: string | undefined): { path: string | null } & UtmFields {
  const fields: { path: string | null } & UtmFields = { path: null, utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null };
  if (!rawPath) return fields;
  const [path, query = ""] = cleanPagePath(rawPath).split("?");
  fields.path = path.slice(0, LONGEST_PATH);
  for (const pair of query.split("&")) {
    const [name, value] = pair.split("=");
    const column = UTM_COLUMNS[name?.toLowerCase() as keyof typeof UTM_COLUMNS];
    if (column && value) fields[column] = decoded(value);
  }
  return fields;
}

/** What anonymous mode lets through of an event: nothing that follows someone or says which campaign brought them. */
export const anonymised = (event: CollectedEvent): CollectedEvent => ({ ...event, userId: null, traits: null, utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null });

/** Where they came from: the host only, and nothing when that's the site itself. */
export function referrerHost(referrer: string | undefined, originHost: string | null): string | null {
  if (!referrer) return null;
  const host = hostOf(referrer);
  if (!host) return null;
  return host === originHost || host === `www.${originHost}` || `www.${host}` === originHost ? null : host;
}

/** When it happened: now, less what the browser says it waited, within reason. */
export const happenedAt = (receivedAt: Date, ago: number | undefined) => new Date(receivedAt.getTime() - Math.min(ago ?? 0, LONGEST_AGO_MS)).toISOString();

export const dayOf = (at: Date | string) => new Date(at).toISOString().slice(0, 10);

/** Every day of a period that ends today and lasts this many days, oldest first. */
export function daysEndingAt(end: Date, days: number): string[] {
  const DAY_MS = 86_400_000;
  return Array.from({ length: days }, (_, index) => dayOf(new Date(end.getTime() - (days - 1 - index) * DAY_MS)));
}
