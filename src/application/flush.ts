import { inArray, sql } from "drizzle-orm";
import { BUFFERED_BATCH, dayOf, type BufferedBatch, type CollectedEvent } from "@/domain/collected";
import { hostAllowed } from "@/domain/sites";
import { sha256 } from "@/infrastructure/crypto/secrets";
import { databaseAnswers } from "@/infrastructure/db/answers";
import type { Database } from "@/infrastructure/db/client";
import { ensureEventPartitions } from "@/infrastructure/db/partitions";
import { rowsOf } from "@/infrastructure/db/rows";
import { flushedBatch, site } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Claim, EventBuffer } from "./event-buffer";
import { rebuildDays, type SiteDay } from "./rollups";

/** Batches read per round: a round is one transaction per workspace, so it has to stay comfortably short. */
const BATCHES_PER_ROUND = 2_000;
/** How long before a function's limit a flush stops starting new rounds. What's left waits for the next run. */
const LONGEST_FLUSH_MS = 240_000;
/** Who someone was just before they identified themselves: same device, same day, this close. */
const STITCH_MINUTES = 30;
const SETTLING_AT_ONCE = 32;

export interface FlushReport {
  /** Nothing was waiting, and the database wasn't touched. */
  idle: boolean;
  batches: number;
  events: number;
  /** Delivered again, already written: skipped. */
  duplicates: number;
  /** Not believable or not allowed: gone, on purpose. */
  dropped: number;
  /** Writing failed: given back, for the next run. */
  failed: number;
}

interface FlushServices {
  db: Database;
  buffer: EventBuffer;
  now: () => Date;
}

interface KnownSite {
  id: string;
  workspaceId: string;
  publicKey: string;
  allowedDomains: string[];
  retentionDays: number;
}

const DAY_MS = 86_400_000;

/** A batch's events still worth keeping: not past the site's retention, which could otherwise rebuild a day whose raw rows are gone. */
function keptEvents(batch: BufferedBatch, known: KnownSite, now: Date): CollectedEvent[] {
  const cutoff = dayOf(new Date(now.getTime() - known.retentionDays * DAY_MS));
  return batch.events.filter(({ at }) => dayOf(at) >= cutoff);
}

function mayKeep(batch: BufferedBatch, known: KnownSite | undefined): known is KnownSite {
  if (!known || known.publicKey !== batch.key) return false;
  return batch.verified || !batch.originHost || hostAllowed(batch.originHost, known.allowedDomains);
}

interface Parsed {
  claim: Claim;
  batch: BufferedBatch;
}

function parseClaims(claims: Claim[]): { parsed: Parsed[]; malformed: Claim[] } {
  const parsed: Parsed[] = [];
  const malformed: Claim[] = [];
  for (const claim of claims) {
    const result = BUFFERED_BATCH.safeParse(claim.batch);
    if (result.success) parsed.push({ claim, batch: result.data });
    else malformed.push(claim);
  }
  return { parsed, malformed };
}

const eventRow = (siteId: string, event: CollectedEvent) => ({
  site_id: siteId,
  at: event.at,
  kind: event.kind,
  path: event.path,
  name: event.name,
  visitor: event.visitor,
  user_id: event.userId,
  referrer: event.referrer,
  utm_source: event.utmSource,
  utm_medium: event.utmMedium,
  utm_campaign: event.utmCampaign,
  utm_term: event.utmTerm,
  utm_content: event.utmContent,
  country: event.country,
  device: event.device,
  browser: event.browser,
  os: event.os,
  props: event.props,
  value: event.value,
});

/** One statement, however many rows: a JSON parameter has no limit on parameters and costs one round trip. */
async function insertEvents(tx: Database, rows: ReturnType<typeof eventRow>[]): Promise<void> {
  await tx.execute(sql`
    insert into event (site_id, at, kind, path, name, visitor, user_id, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content, country, device, browser, os, props, value)
    select site_id, at, kind::event_kind, path, name, visitor, user_id, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content, country, device, browser, os, props, value
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(site_id uuid, at timestamptz, kind text, path text, name text, visitor uuid, user_id text, referrer text, utm_source text, utm_medium text, utm_campaign text, utm_term text, utm_content text, country text, device text, browser text, os text, props jsonb, value real)`);
}

interface Identified {
  site_id: string;
  visitor: string;
  user_id: string;
  at: string;
}

/**
 * What a visitor did just before signing in becomes theirs, so a funnel that starts anonymous and ends
 * signed in stays one person's. Same hash, same day, and only the half hour before: a hash is shared
 * by everyone behind an office's address with the same browser, and that's as far as it should be trusted.
 */
async function stitchVisitors(tx: Database, identified: Identified[]): Promise<void> {
  if (identified.length === 0) return;
  // Written out as well as joined: from a list alone, the database can't tell which partitions matter.
  const moments = identified.map(({ at }) => at).sort();
  const earliest = new Date(new Date(moments[0]).getTime() - STITCH_MINUTES * 60_000).toISOString();
  await tx.execute(sql`
    update event e set user_id = i.user_id
    from jsonb_to_recordset(${JSON.stringify(identified)}::jsonb) as i(site_id uuid, visitor uuid, user_id text, at timestamptz)
    where e.at >= ${earliest}::timestamptz and e.at <= ${moments.at(-1)}::timestamptz
      and e.site_id = i.site_id and e.visitor = i.visitor and e.user_id is null and e.at <= i.at and e.at >= i.at - make_interval(mins => ${STITCH_MINUTES})`);
}

interface PersonRow {
  site_id: string;
  user_id: string;
  traits: Record<string, unknown>;
  first: string;
  last: string;
}

function peopleIn(rows: { siteId: string; event: CollectedEvent }[]): PersonRow[] {
  const people = new Map<string, PersonRow>();
  for (const { siteId, event } of rows) {
    if (!event.userId) continue;
    const key = `${siteId}\n${event.userId}`;
    const seen = people.get(key) ?? { site_id: siteId, user_id: event.userId, traits: {}, first: event.at, last: event.at };
    if (event.at < seen.first) seen.first = event.at;
    if (event.at > seen.last) seen.last = event.at;
    Object.assign(seen.traits, event.traits);
    people.set(key, seen);
  }
  return [...people.values()];
}

async function upsertPeople(tx: Database, people: PersonRow[]): Promise<void> {
  if (people.length === 0) return;
  await tx.execute(sql`
    insert into person (site_id, user_id, traits, first_seen_at, last_seen_at)
    select site_id, user_id, traits, first, last from jsonb_to_recordset(${JSON.stringify(people)}::jsonb) as p(site_id uuid, user_id text, traits jsonb, first timestamptz, last timestamptz)
    on conflict (site_id, user_id) do update set
      traits = person.traits || excluded.traits,
      first_seen_at = least(person.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(person.last_seen_at, excluded.last_seen_at)`);
}

/** Hashes of who has been erased on these sites, and when: what's still in the buffer about them doesn't get written. */
async function erasuresOn(tx: Database, siteIds: string[]): Promise<Map<string, string>> {
  const rows = await rowsOf<{ site_id: string; user_hash: string; erased_at: string }>(tx, sql`select site_id, user_hash, to_json(erased_at)#>>'{}' as erased_at from erased_person where site_id in (${sql.join(siteIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  return new Map(rows.map(({ site_id, user_hash, erased_at }) => [`${site_id}\n${user_hash}`, new Date(erased_at).toISOString()]));
}

export const personHash = (siteId: string, userId: string) => sha256(`${siteId}\n${userId}`);

function afterErasures(rows: { siteId: string; event: CollectedEvent }[], erased: Map<string, string>) {
  if (erased.size === 0) return rows;
  return rows.filter(({ siteId, event }) => {
    if (!event.userId) return true;
    const when = erased.get(`${siteId}\n${personHash(siteId, event.userId)}`);
    return !when || event.at > when;
  });
}

const touchedDays = (rows: { siteId: string; event: CollectedEvent }[]): SiteDay[] => [...new Map(rows.map(({ siteId, event }) => [`${siteId}\n${dayOf(event.at)}`, { siteId, day: dayOf(event.at) }])).values()];

/**
 * Writes one workspace's batches, all or nothing: the ledger, the events, who they turned out to be,
 * and the days' rollups commit together. So a failure leaves nothing to undo and a retry finds nothing
 * done, while a batch that did commit finds its id in the ledger and adds nothing. Runs as the app
 * role, so a mistake here can't write into another workspace.
 */
async function writeWorkspace(db: Database, workspaceId: string, parsed: Parsed[], sites: Map<string, KnownSite>, now: Date): Promise<{ events: number; duplicates: number }> {
  return withWorkspace(db, workspaceId, async (tx) => {
    // A buffer may hand out one batch twice in the same round, so its copies go too.
    const distinct = [...new Map(parsed.map(({ batch }) => [batch.id, batch])).values()];
    const ledger = distinct.map(({ id }) => ({ batchId: id, flushedAt: now }));
    const fresh = new Set((await tx.insert(flushedBatch).values(ledger).onConflictDoNothing().returning({ id: flushedBatch.batchId })).map(({ id }) => id));
    const batches = distinct.filter(({ id }) => fresh.has(id));
    const duplicates = parsed.length - batches.length;
    if (batches.length === 0) return { events: 0, duplicates };
    const siteIds = [...new Set(batches.map(({ siteId }) => siteId))];
    const seen = batches.flatMap((batch) => keptEvents(batch, sites.get(batch.siteId) as KnownSite, now).map((event) => ({ siteId: batch.siteId, event })));
    const rows = afterErasures(seen, await erasuresOn(tx, siteIds));
    if (rows.length > 0) await writeRows(tx, rows);
    await tx.update(site).set({ lastWrittenAt: now }).where(inArray(site.id, siteIds));
    return { events: rows.length, duplicates };
  });
}

async function writeRows(tx: Database, rows: { siteId: string; event: CollectedEvent }[]): Promise<void> {
  await insertEvents(tx, rows.map(({ siteId, event }) => eventRow(siteId, event)));
  const identified = rows.filter(({ event }) => event.kind === "identify" && event.visitor).map(({ siteId, event }) => ({ site_id: siteId, visitor: event.visitor as string, user_id: event.userId as string, at: event.at }));
  await stitchVisitors(tx, identified);
  await upsertPeople(tx, peopleIn(rows));
  await rebuildDays(tx, touchedDays(rows));
}

async function knownSites(db: Database, batches: Parsed[]): Promise<Map<string, KnownSite>> {
  const ids = [...new Set(batches.map(({ batch }) => batch.siteId))];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: site.id, workspaceId: site.workspaceId, publicKey: site.publicKey, allowedDomains: site.allowedDomains, retentionDays: site.retentionDays }).from(site).where(inArray(site.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

function byWorkspace(batches: Parsed[], sites: Map<string, KnownSite>): Map<string, Parsed[]> {
  const groups = new Map<string, Parsed[]>();
  for (const parsed of batches) {
    const { workspaceId } = sites.get(parsed.batch.siteId) as KnownSite;
    const group = groups.get(workspaceId);
    if (group) group.push(parsed);
    else groups.set(workspaceId, [parsed]);
  }
  return groups;
}

const emptyReport = (): FlushReport => ({ idle: false, batches: 0, events: 0, duplicates: 0, dropped: 0, failed: 0 });

/** Settling can be a request each, so a few at a time: a thousand at once would be refused, or run a function out of sockets. */
async function settleInTurns(claims: Claim[], settle: (claim: Claim) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < claims.length) await settle(claims[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(SETTLING_AT_ONCE, claims.length) }, worker));
}

const done = (claim: Claim) => claim.done();
const giveBack = (claim: Claim) => claim.giveBack();

/**
 * What failed so far in this run. Its batches stay claimed until the run ends: given back at once they
 * would come straight back as the next round, ahead of everything behind them, and a workspace that
 * can't be written would keep the rest of the queue waiting.
 */
interface FailedSoFar {
  claims: Claim[];
  workspaces: Set<string>;
}

/** One round: what's claimed gets settled or held before this returns, one way or the other. */
async function flushRound(services: FlushServices, claims: Claim[], report: FlushReport, failed: FailedSoFar): Promise<void> {
  const { parsed, malformed } = parseClaims(claims);
  await settleInTurns(malformed, done);
  report.dropped += malformed.length;
  const sites = await knownSites(services.db, parsed);
  const keepers = parsed.filter(({ batch }) => mayKeep(batch, sites.get(batch.siteId)));
  const refused = parsed.length - keepers.length;
  if (refused > 0)
    await settleInTurns(
      parsed.filter(({ batch }) => !mayKeep(batch, sites.get(batch.siteId))).map(({ claim }) => claim),
      done,
    );
  report.dropped += refused;
  for (const [workspaceId, batches] of byWorkspace(keepers, sites)) {
    try {
      if (failed.workspaces.has(workspaceId)) throw new Error("It already failed in this run.");
      // Only what will be kept: an event past its site's retention isn't written, and has no need of a partition.
      await ensureEventPartitions(services.db, batches.flatMap(({ batch }) => keptEvents(batch, sites.get(batch.siteId) as KnownSite, services.now()).map(({ at }) => at)));
      const { events, duplicates } = await writeWorkspace(services.db, workspaceId, batches, sites, services.now());
      Object.assign(report, { batches: report.batches + batches.length - duplicates, events: report.events + events, duplicates: report.duplicates + duplicates });
      await settleInTurns(batches.map(({ claim }) => claim), done);
    } catch (error) {
      if (!failed.workspaces.has(workspaceId)) console.error(`Flush failed for workspace ${workspaceId}; its batches go back:`, error);
      report.failed += batches.length;
      failed.workspaces.add(workspaceId);
      failed.claims.push(...batches.map(({ claim }) => claim));
    }
  }
}

/**
 * Empties the buffer into Postgres, or as much as fits in a run. Nothing waiting means no database at
 * all, so a quiet hour lets it sleep. A workspace that fails stops neither the others nor what is
 * queued behind it, and what failed goes back to the buffer as the run ends, which keeps it until a
 * later run succeeds.
 */
export async function flushBuffer(services: FlushServices, longestMs = LONGEST_FLUSH_MS, waitForDatabaseMs?: number): Promise<FlushReport> {
  const report = emptyReport();
  const startedAt = Date.now();
  const failed: FailedSoFar = { claims: [], workspaces: new Set() };
  try {
    for (;;) {
      const claims = await services.buffer.claim(BATCHES_PER_ROUND);
      if (claims.length === 0) {
        report.idle = report.batches + report.duplicates + report.dropped + report.failed === 0;
        return report;
      }
      try {
        if (!(await databaseAnswers(services.db, waitForDatabaseMs))) throw new Error("The database isn’t answering.");
        await flushRound(services, claims, report, failed);
      } catch (error) {
        // The database didn't answer at all: everything claimed goes back, and it's no use trying more now.
        console.error("Flush stopped:", error);
        report.failed += claims.length;
        await settleInTurns(claims, giveBack);
        return report;
      }
      if (Date.now() - startedAt > longestMs) return report;
    }
  } finally {
    await settleInTurns(failed.claims, giveBack);
  }
}

