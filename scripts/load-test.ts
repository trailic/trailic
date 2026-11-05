/**
 * What a site's traffic costs on a real Postgres: loads synthetic events, then measures table sizes,
 * flush time and query time. For a throwaway database: it refuses anything but localhost.
 *
 *   TRAILIC_DATABASE_URL=postgres://…@localhost:…/load pnpm load-test --events 5000000 --sites 30 --days 120
 */
import { sql } from "drizzle-orm";
import { retentionOf } from "@/application/cohorts";
import type { Claim, EventBuffer } from "@/application/event-buffer";
import { flushBuffer } from "@/application/flush";
import { journeysOf } from "@/application/journeys";
import { overviewOf } from "@/application/overview";
import { rebuildDays } from "@/application/rollups";
import { runFunnel } from "@/application/funnels";
import { periodEndingAt } from "@/application/time-range";
import { dayOf, type CollectedEvent } from "@/domain/collected";
import type { FunnelStepInput } from "@/domain/funnels";
import { mintSiteKey } from "@/infrastructure/crypto/site-key";
import { connect, type Database } from "@/infrastructure/db/client";
import { ensureEventPartitions } from "@/infrastructure/db/partitions";
import { rowsOf } from "@/infrastructure/db/rows";
import { withWorkspace } from "@/infrastructure/db/tenant";

const SECRET = "a-long-enough-secret-for-synthetic-site-keys";
const DAY_MS = 86_400_000;
const AVERAGE_ROWS_PER_VISITOR = 3;

function argument(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
}

const seconds = (since: number) => Number(((performance.now() - since) / 1000).toFixed(1));

async function setUp(db: Database, sites: number) {
  const userId = crypto.randomUUID();
  await db.execute(sql`insert into "user" (id, name, email) values (${userId}, 'Load test', ${`${userId}@example.test`})`);
  const workspaceId = crypto.randomUUID();
  await db.execute(sql`insert into workspace (id, name, slug) values (${workspaceId}::uuid, 'Load test', ${workspaceId})`);
  await db.execute(sql`insert into member (workspace_id, user_id, role) values (${workspaceId}::uuid, ${userId}, 'owner')`);
  const ids = Array.from({ length: sites }, () => crypto.randomUUID());
  const keys = ids.map((id) => mintSiteKey(id, SECRET));
  for (const [index, id] of ids.entries()) {
    await db.execute(sql`insert into site (id, workspace_id, name, public_key, allowed_domains) values (${id}::uuid, ${workspaceId}::uuid, ${`Site ${index + 1}`}, ${keys[index]}, array[${`site${index + 1}.example`}::text])`);
  }
  return { workspaceId, ids, keys };
}

/**
 * A few rows per visitor: most wander, one in twenty goes for the sign-up funnel, one in twelve is
 * identified, and identified people come back for a few weeks. Each trait reads its own part of a
 * visitor's hash, so none of them go together by accident.
 */
function loadSiteDay(db: Database, workspaceId: string, siteId: string, day: string, week: number, visitors: number) {
  const peoplePerWeek = Math.max(5, Math.round((visitors * 7) / 36));
  return db.execute(sql`
    insert into event (workspace_id, site_id, at, kind, path, name, visitor, user_id, referrer, utm_source, utm_medium, utm_campaign, country, device, browser, os, props, value)
    select ${workspaceId}::uuid, ${siteId}::uuid,
      (${day}::date::timestamp at time zone 'UTC') + make_interval(secs => (v.seed % 85000 + step * 45)::float8),
      r.kind::event_kind,
      r.path,
      r.name,
      md5(${siteId}::text || ${day}::text || n::text)::uuid,
      case when (v.seed / 101) % 12 = 0 then 'user_' || (${week}::int - (v.seed / 211) % 6) || '_' || ((v.seed / 7) % ${peoplePerWeek}::int) end,
      case when step = 0 and (v.seed / 5) % 3 = 0 then (array['news.example', 'search.example', 'social.example', 'forum.example'])[1 + (v.seed / 11) % 4] end,
      case when step = 0 and (v.seed / 3) % 16 = 0 then (array['news', 'partner', 'ads'])[1 + (v.seed / 41) % 3] end,
      case when step = 0 and (v.seed / 3) % 16 = 0 then (array['mail', 'cpc'])[1 + (v.seed / 43) % 2] end,
      case when step = 0 and (v.seed / 3) % 16 = 0 then (array['autumn', 'launch'])[1 + (v.seed / 47) % 2] end,
      (array['FR', 'DE', 'US', 'GB', 'ES', 'IT', 'NL', 'CA'])[1 + (v.seed / 19) % 8],
      (array['desktop', 'mobile', 'tablet'])[1 + (v.seed / 23) % 3],
      (array['Chrome', 'Safari', 'Firefox', 'Edge'])[1 + (v.seed / 29) % 4],
      (array['macOS', 'Windows', 'iOS', 'Android', 'Linux'])[1 + (v.seed / 37) % 5],
      case when r.kind = 'event' then '{"plan":"pro"}'::jsonb end,
      case when r.kind = 'vital' then (random() * 3000)::real end
    from generate_series(1, ${visitors}::int) as n
    cross join lateral (select hashtext(${siteId}::text || ${day}::text || n::text) & 2147483647 as seed) v
    cross join lateral generate_series(0, (v.seed / 31) % 5) as step
    cross join lateral (
      select
        case when (v.seed / 1009) % 20 = 0 and step = 1 then 'event' when (v.seed / 17) % 8 = 1 and step = 2 then 'event' when (v.seed / 13) % 100 = 7 and step = 1 then 'vital' else 'page' end as kind,
        case when (v.seed / 1009) % 20 = 0 and step = 0 then '/pricing' when (v.seed / 1009) % 20 = 0 and step = 2 then '/welcome' when step = 0 then '/' else '/p/' || floor(power(random(), 3) * 300)::int end as path,
        case when (v.seed / 1009) % 20 = 0 and step = 1 then 'signup' when (v.seed / 17) % 8 = 1 and step = 2 then (array['click', 'search', 'download'])[1 + (v.seed / 53) % 3] when (v.seed / 13) % 100 = 7 and step = 1 then 'LCP' end as name
    ) r`);
}

interface Loaded {
  workspaceId: string;
  ids: string[];
  keys: string[];
}

/** Spreads events over days, and over sites as real traffic is spread: the biggest has a quarter of it, the smallest almost nothing. */
async function load(db: Database, { workspaceId, ids }: Loaded, events: number, days: number, now: Date): Promise<void> {
  const dates = Array.from({ length: days }, (_, index) => dayOf(new Date(now.getTime() - index * DAY_MS))).reverse();
  await ensureEventPartitions(db, dates);
  const harmonic = ids.reduce((total, _, index) => total + 1 / (index + 1), 0);
  const started = performance.now();
  for (const [dayIndex, day] of dates.entries()) {
    for (const [index, siteId] of ids.entries()) {
      const rows = (events / days) * (1 / (index + 1) / harmonic);
      const visitors = Math.max(1, Math.round(rows / AVERAGE_ROWS_PER_VISITOR));
      await loadSiteDay(db, workspaceId, siteId, day, Math.floor(dayIndex / 7), visitors);
    }
    if (dayIndex % 10 === 0) console.log(`Loaded ${dayIndex + 1}/${days} days, ${seconds(started)}s`);
  }
  await db.execute(sql`insert into person (workspace_id, site_id, user_id, first_seen_at, last_seen_at) select workspace_id, site_id, user_id, min(at), max(at) from event where user_id is not null group by 1, 2, 3 on conflict do nothing`);
  console.log(`Loaded events in ${seconds(started)}s`);
  await rebuildAll(db, { workspaceId, ids }, dates);
}

/** Every rollup of the period, a day at a time, as if each had been flushed. */
async function rebuildAll(db: Database, { workspaceId, ids }: Pick<Loaded, "workspaceId" | "ids">, dates: string[]): Promise<void> {
  const rollups = performance.now();
  for (const day of dates) await withWorkspace(db, workspaceId, (tx) => rebuildDays(tx, ids.map((siteId) => ({ siteId, day }))));
  console.log(`Built all rollups in ${seconds(rollups)}s`);
  await db.execute(sql`vacuum analyze`);
}

async function tableSizes(db: Database) {
  const rows = await rowsOf<{ name: string; rows: number; total_mb: number; table_mb: number; index_mb: number }>(db, sql`
    select coalesce(i.parent, c.relname) as name,
      sum(c.reltuples)::bigint::float8 as rows,
      round(sum(pg_total_relation_size(c.oid)) / 1048576.0, 1)::float8 as total_mb,
      round(sum(pg_table_size(c.oid)) / 1048576.0, 1)::float8 as table_mb,
      round(sum(pg_indexes_size(c.oid)) / 1048576.0, 1)::float8 as index_mb
    from pg_class c
    left join lateral (select p.relname as parent from pg_inherits h join pg_class p on p.oid = h.inhparent where h.inhrelid = c.oid) i on true
    where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace and coalesce(i.parent, c.relname) in ('event', 'daily_site', 'daily_dimension', 'daily_vital', 'person', 'flushed_batch', 'site')
    group by 1 order by 3 desc`);
  const indexes = await rowsOf<{ name: string; mb: number }>(db, sql`
    select regexp_replace(c.relname, '^event_\d+_\d+_', '') as name, round(sum(pg_relation_size(c.oid)) / 1048576.0, 1)::float8 as mb
    from pg_class c join pg_index x on x.indexrelid = c.oid join pg_class t on t.oid = x.indrelid
    where t.relname like 'event_%' and c.relkind = 'i' group by 1 order by 2 desc`);
  return { tables: rows, eventIndexes: indexes };
}

function memoryBatches(key: { siteId: string; key: string }[], batches: number, now: Date): EventBuffer {
  const waiting: unknown[] = Array.from({ length: batches }, (_, index) => {
    const site = key[index % key.length];
    const at = new Date(now.getTime() - (index % 3_600) * 1000).toISOString();
    const event: CollectedEvent = { kind: "page", at, path: `/p/${index % 300}`, name: null, visitor: crypto.randomUUID(), userId: null, referrer: null, utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, country: "FR", device: "desktop", browser: "Firefox", os: "Linux", props: null, traits: null, value: null };
    return { id: crypto.randomUUID(), siteId: site.siteId, key: site.key, originHost: null, verified: true, events: [event] };
  });
  return {
    append: async () => {},
    claim: async (max): Promise<Claim[]> => waiting.splice(0, max).map((batch) => ({ batch, deliveries: 1, done: async () => {}, giveBack: async () => void waiting.push(batch) })),
  };
}

/** A real hour's worth at the volume this is designed for, then a smaller and a larger one, on a database already holding the rest. */
async function measureFlush(db: Database, { ids, keys }: Loaded, now: Date) {
  const sites = ids.map((siteId, index) => ({ siteId, key: keys[index] }));
  const results: { batches: number; sites: number; seconds: number; events: number }[] = [];
  for (const [batches, spread] of [[500, sites.length], [4_500, sites.length], [4_500, 1], [20_000, sites.length]] as const) {
    const started = performance.now();
    const report = await flushBuffer({ db, buffer: memoryBatches(sites.slice(0, spread), batches, now), now: () => now });
    results.push({ batches, sites: spread, seconds: seconds(started), events: report.events });
    console.log(results.at(-1));
  }
  return results;
}

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const started = performance.now();
  const result = await work();
  return { ms: Math.round(performance.now() - started), result };
}

const SIGN_UP: FunnelStepInput[] = [
  { kind: "page", match: "/pricing" },
  { kind: "event", match: "signup" },
  { kind: "page", match: "/welcome" },
];

async function measureQueries(db: Database, { workspaceId, ids }: Loaded, now: Date) {
  const biggest = ids[0];
  const queries: Record<string, () => Promise<unknown>> = {
    "overview, all sites": async () => overviewOf(db, workspaceId, null, periodEndingAt(now, 30)),
  };
  for (const days of [30, 90]) {
    const period = periodEndingAt(now, days);
    queries[`overview, biggest site, ${days} days`] = () => overviewOf(db, workspaceId, biggest, period);
    queries[`overview, all sites, ${days} days`] = () => overviewOf(db, workspaceId, null, period);
    queries[`funnel, biggest site, ${days} days`] = () => runFunnel(db, workspaceId, { siteId: biggest, steps: SIGN_UP, windowHours: 24, period });
    queries[`journeys from /, biggest site, ${days} days`] = () => journeysOf(db, workspaceId, { siteId: biggest, startPath: "/", period });
    queries[`journeys from /pricing, biggest site, ${days} days`] = () => journeysOf(db, workspaceId, { siteId: biggest, startPath: "/pricing", period });
  }
  for (const weeks of [4, 13]) queries[`retention, biggest site, ${weeks} weeks`] = () => retentionOf(db, workspaceId, { siteId: biggest, weeks, now });
  queries["retention by an event, biggest site, 13 weeks"] = () => retentionOf(db, workspaceId, { siteId: biggest, weeks: 13, eventName: "signup", now });
  const results: Record<string, { first: number; median: number }> = {};
  for (const [name, query] of Object.entries(queries)) {
    const runs: number[] = [];
    for (let run = 0; run < 3; run += 1) runs.push((await timed(query)).ms);
    results[name] = { first: runs[0], median: [...runs].sort((a, b) => a - b)[1] };
    console.log(name, results[name]);
  }
  return results;
}

async function resume(db: Database): Promise<Loaded | null> {
  const sites = await rowsOf<{ id: string; workspace_id: string; public_key: string; views: number }>(db, sql`select s.id, s.workspace_id, s.public_key, coalesce((select sum(d.page_views) from daily_site d where d.site_id = s.id), 0)::float8 as views from site s order by views desc`);
  if (sites.length === 0) return null;
  return { workspaceId: sites[0].workspace_id, ids: sites.map(({ id }) => id), keys: sites.map(({ public_key }) => public_key) };
}

async function main() {
  const url = process.env.TRAILIC_DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("This writes millions of rows: it only runs on a database on this machine.");
  const db = connect(url);
  const now = new Date();
  let loaded = await resume(db);
  if (!loaded) {
    loaded = await setUp(db, argument("sites", 30));
    await load(db, loaded, argument("events", 5_000_000), argument("days", 120), now);
  } else if (process.argv.includes("--rebuild")) {
    const days = argument("days", 120);
    await rebuildAll(db, loaded, Array.from({ length: days }, (_, index) => dayOf(new Date(now.getTime() - index * DAY_MS))).reverse());
  }
  const [{ count }] = await rowsOf<{ count: number }>(db, sql`select count(*)::float8 as count from event`);
  console.log(JSON.stringify({ events: count, sizes: await tableSizes(db) }, null, 2));
  const onlyQueries = process.argv.includes("--queries-only");
  const flush = onlyQueries ? null : await measureFlush(db, loaded, now);
  const queries = await measureQueries(db, loaded, now);
  console.log(JSON.stringify({ flush, queries, sizesAfter: await tableSizes(db) }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
