import { z } from "zod";
import { isPersonalArea } from "./anonymous";
import { pathAndCampaign } from "./collected";
import { hostOf } from "./sites";

/**
 * A day of figures another tool counted, as a file gives it, and what's kept of it: the same as the
 * collector would keep. Whoever wrote the file is trusted about the counts and about nothing else, so
 * its values go through the collector's own rules.
 */

const DIRECT = "(direct)";
const UNKNOWN = "(unknown)";
const DEVICES = ["desktop", "mobile", "tablet", UNKNOWN];
const LONGEST_NAME = 64;
const LONGEST_CLIENT = 40;
const LONGEST_TAG = 200;
const MOST_ROWS_A_DAY = 50_000;

export const HISTORY_DIMENSIONS = ["page", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "country", "device", "browser", "os", "event"] as const;
export type HistoryDimension = (typeof HISTORY_DIMENSIONS)[number];

const COUNT = z.number().int().min(0);
const DIMENSION_ROW = z.object({ value: z.string().min(1).max(4096), count: COUNT, visitors: COUNT });

export const IMPORTED_DAY = z
  .object({
    day: z.iso.date(),
    visitors: COUNT,
    pageViews: COUNT,
    events: COUNT,
    bounces: COUNT,
    dimensions: z.partialRecord(z.enum(HISTORY_DIMENSIONS), z.array(DIMENSION_ROW).max(MOST_ROWS_A_DAY)).default({}),
  })
  .refine(({ visitors, pageViews, bounces }) => visitors <= pageViews && bounces <= visitors, "A visitor saw a page, and a bounce is a visitor.");

export type ImportedDay = z.infer<typeof IMPORTED_DAY>;

/** A line of a history file: one site's day. */
export const HISTORY_LINE = z.intersection(z.object({ site: z.uuid() }), IMPORTED_DAY);

export interface CleanedRow {
  dimension: HistoryDimension;
  value: string;
  count: number;
  visitors: number;
}

export interface CleanedDay {
  day: string;
  visitors: number;
  pageViews: number;
  events: number;
  bounces: number;
  rows: CleanedRow[];
}

function cleanedPage(value: string, anonymous: boolean): string | null {
  if (!value.startsWith("/")) return null;
  const { path } = pathAndCampaign(value);
  return path && !(anonymous && isPersonalArea(path)) ? path : null;
}

const CLEANERS: Record<HistoryDimension, (value: string, anonymous: boolean) => string | null> = {
  page: cleanedPage,
  referrer: (value) => (value === DIRECT ? DIRECT : hostOf(value)),
  utm_source: (value, anonymous) => (anonymous ? null : value.slice(0, LONGEST_TAG)),
  utm_medium: (value, anonymous) => (anonymous ? null : value.slice(0, LONGEST_TAG)),
  utm_campaign: (value, anonymous) => (anonymous ? null : value.slice(0, LONGEST_TAG)),
  utm_term: (value, anonymous) => (anonymous ? null : value.slice(0, LONGEST_TAG)),
  utm_content: (value, anonymous) => (anonymous ? null : value.slice(0, LONGEST_TAG)),
  country: (value) => (/^[A-Z]{2}$/.test(value) ? value : UNKNOWN),
  device: (value) => (DEVICES.includes(value) ? value : UNKNOWN),
  browser: (value) => value.slice(0, LONGEST_CLIENT),
  os: (value) => value.slice(0, LONGEST_CLIENT),
  event: (value) => value.slice(0, LONGEST_NAME),
};

/** Two values can clean to one, such as two tokens in a path. Someone seen on both counts once on the day, which is the most this can say. */
function mergedRows(day: ImportedDay, anonymous: boolean): { rows: CleanedRow[]; pagesDropped: number } {
  const merged = new Map<string, CleanedRow>();
  let pagesDropped = 0;
  for (const dimension of HISTORY_DIMENSIONS) {
    for (const { value, count, visitors } of day.dimensions[dimension] ?? []) {
      const cleaned = CLEANERS[dimension](value, anonymous);
      if (cleaned === null) {
        if (dimension === "page") pagesDropped += count;
        continue;
      }
      const key = `${dimension}\n${cleaned}`;
      const known = merged.get(key);
      merged.set(key, { dimension, value: cleaned, count: (known?.count ?? 0) + count, visitors: Math.min((known?.visitors ?? 0) + visitors, day.visitors) });
    }
  }
  return { rows: [...merged.values()].sort((a, b) => a.dimension.localeCompare(b.dimension) || (a.value < b.value ? -1 : 1)), pagesDropped };
}

/** What's kept of a day, or nothing when none of it may be kept. A page dropped here comes off the day's totals too: nothing the collector wouldn't count is counted. */
export function cleanedDay(day: ImportedDay, anonymous: boolean): CleanedDay | null {
  const { rows, pagesDropped } = mergedRows(day, anonymous);
  const pageViews = Math.max(day.pageViews - pagesDropped, 0);
  if (pageViews === 0 && day.events === 0) return null;
  const visitors = Math.min(day.visitors, pageViews);
  return { day: day.day, visitors, pageViews, events: day.events, bounces: Math.min(day.bounces, visitors), rows };
}

export interface SiteHistory {
  siteId: string;
  days: ImportedDay[];
}

export class HistoryFileError extends Error {}

/**
 * A history file's sites, one at a time, so that one with a large history doesn't hold the rest in
 * memory. A site's lines have to be together: finding it again later would replace what was just
 * written. A bad line says only where it is, since what's on it may be someone's.
 */
export async function* sitesInFile(lines: AsyncIterable<string>): AsyncGenerator<SiteHistory> {
  const seen = new Set<string>();
  let current = null as SiteHistory | null;
  let number = 0;
  for await (const line of lines) {
    number += 1;
    if (!line.trim()) continue;
    const parsed = parsedLine(line, number);
    if (parsed.site !== current?.siteId) {
      if (current) yield current;
      if (seen.has(parsed.site)) throw new HistoryFileError(`Line ${number}: a site’s lines have to be together.`);
      seen.add(parsed.site);
      current = { siteId: parsed.site, days: [] };
    }
    current.days.push(parsed);
  }
  if (current) yield current;
}

function parsedLine(line: string, number: number) {
  try {
    const parsed = HISTORY_LINE.safeParse(JSON.parse(line));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: refused below, like anything else that isn't a day.
  }
  throw new HistoryFileError(`Line ${number} isn’t a day of figures.`);
}
