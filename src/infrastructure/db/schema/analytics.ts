import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgEnum, pgTable, primaryKey, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { DEFAULT_RETENTION_DAYS } from "@/domain/sites";
import { createdAt, tenantIsolation, updatedAt, workspaceColumn } from "./shared";
import { workspace } from "./tenancy";

// ─── Sites ─────────────────────────────────────────────────────────────────

export const site = pgTable(
  "site",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn().references(() => workspace.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** The key its pages send with: public, and signed so a forged one is refused without asking this table (see crypto/site-key). */
    publicKey: text().notNull().unique(),
    /** Hosts its pages may send from, subdomains included. */
    allowedDomains: text().array().notNull(),
    /** How long raw events stay; daily rollups stay for good. */
    retentionDays: integer().notNull().default(DEFAULT_RETENTION_DAYS),
    /** When events were last written to the database: dashboards say how old they are. */
    lastWrittenAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.workspaceId, table.name), tenantIsolation()],
).enableRLS();

// ─── Raw events ────────────────────────────────────────────────────────────
//
// Partitioned by month in the migration, which Drizzle's schema can't say: old months go by dropping
// a partition, and a query for a month reads that month. Partitions are made as events need them
// (ensure_event_partition), each with row-level security of its own, since a partition read directly
// doesn't go through its parent's policies. No primary key: batches are what's kept idempotent, and an
// index nothing reads would be a third of the table's size.

export const eventKind = pgEnum("event_kind", ["page", "event", "identify", "vital"]);

export const event = pgTable(
  "event",
  {
    workspaceId: workspaceColumn(),
    siteId: uuid()
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    at: timestamp({ withTimezone: true }).notNull(),
    kind: eventKind().notNull(),
    /** The page's path, cleaned of what could identify someone (see packages/trailic/src/clean-url). */
    path: text(),
    /** A custom event's or a web vital's name. */
    name: text(),
    /** The day's salted hash, never the address it came from. Null for what a server sent. */
    visitor: uuid(),
    /** Only once the site called identify, and what they did in the half hour before. */
    userId: text(),
    /** The host they came from. Null when they came from nowhere or from the site itself. */
    referrer: text(),
    utmSource: text(),
    utmMedium: text(),
    utmCampaign: text(),
    utmTerm: text(),
    utmContent: text(),
    country: text(),
    device: text(),
    browser: text(),
    os: text(),
    props: jsonb().$type<Record<string, string | number | boolean>>(),
    /** A web vital's measure. */
    value: real(),
  },
  (table) => [
    index("event_site_at").on(table.siteId, table.at),
    index("event_site_visitor_at").on(table.siteId, table.visitor, table.at).where(sql`visitor is not null`),
    index("event_site_user_at").on(table.siteId, table.userId, table.at).where(sql`user_id is not null`),
    index("event_site_path_at").on(table.siteId, table.path, table.at).where(sql`kind = 'page'`),
    index("event_site_name_at").on(table.siteId, table.name, table.at).where(sql`kind = 'event'`),
    tenantIsolation(),
  ],
).enableRLS();

// ─── Daily rollups ─────────────────────────────────────────────────────────
//
// Rebuilt from raw rows for the days a flush touched, and kept after those rows are gone: every
// dashboard reads these, so a month-old chart costs the same as today's. Days are UTC. A visitor is a
// visitor on one day: the hash rotates, so totals over a period add days up.

export const dailySite = pgTable(
  "daily_site",
  {
    workspaceId: workspaceColumn(),
    siteId: uuid()
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    day: date().notNull(),
    visitors: integer().notNull(),
    pageViews: integer().notNull(),
    events: integer().notNull(),
    /** Visitors who saw one page that day. */
    bounces: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.day] }), index().on(table.workspaceId, table.day), tenantIsolation()],
).enableRLS();

export const DIMENSIONS = ["page", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "country", "device", "browser", "os", "event"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const dailyDimension = pgTable(
  "daily_dimension",
  {
    workspaceId: workspaceColumn(),
    siteId: uuid()
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    day: date().notNull(),
    /**
     * Text rather than an enum, on purpose: comparing enums isn't leakproof, so behind row-level
     * security Postgres won't use an index on one, and each list on a dashboard read the whole table.
     */
    dimension: text().$type<Dimension>().notNull(),
    value: text().notNull(),
    /** Page views, or a custom event's occurrences. */
    count: integer().notNull(),
    visitors: integer().notNull(),
  },
  // The dimension before the day, so a workspace's top pages read its pages and not its whole period.
  (table) => [primaryKey({ columns: [table.siteId, table.day, table.dimension, table.value] }), index().on(table.workspaceId, table.dimension, table.day), tenantIsolation()],
).enableRLS();

export const dailyVital = pgTable(
  "daily_vital",
  {
    workspaceId: workspaceColumn(),
    siteId: uuid()
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    day: date().notNull(),
    metric: text().notNull(),
    p75: real().notNull(),
    samples: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.day, table.metric] }), tenantIsolation()],
).enableRLS();

// ─── People ────────────────────────────────────────────────────────────────

/** Someone a site identified. What a site says about them stays with them, and goes when they're erased. */
export const person = pgTable(
  "person",
  {
    workspaceId: workspaceColumn(),
    siteId: uuid()
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    traits: jsonb().$type<Record<string, string | number | boolean>>().notNull().default({}),
    /** Kept when raw events age out: retention cohorts are built on it. */
    firstSeenAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.userId] }), index().on(table.siteId, table.lastSeenAt), tenantIsolation()],
).enableRLS();

/**
 * That someone was erased, so what's still in the buffer about them is dropped when it arrives. Only
 * a hash of who: this table exists to forget them. Goes once the buffer can't hold anything older.
 */
export const erasedPerson = pgTable(
  "erased_person",
  {
    workspaceId: workspaceColumn(),
    siteId: uuid()
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    userHash: text().notNull(),
    erasedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.siteId, table.userHash] }), tenantIsolation()],
).enableRLS();

// ─── Funnels ───────────────────────────────────────────────────────────────

export interface FunnelStep {
  kind: "page" | "event";
  /** A path (a trailing * matches anything after it) or a custom event's name. */
  match: string;
}

export const funnel = pgTable(
  "funnel",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn(),
    siteId: uuid()
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    name: text().notNull(),
    steps: jsonb().$type<FunnelStep[]>().notNull(),
    /** How long after the first step the rest still count. */
    windowHours: integer().notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique().on(table.siteId, table.name), tenantIsolation()],
).enableRLS();

// ─── What a flush has written ──────────────────────────────────────────────

/**
 * Batches already written, for a buffer that delivers at least once: a batch delivered again finds
 * its id here, in the same transaction as its events, and is skipped.
 */
export const flushedBatch = pgTable(
  "flushed_batch",
  {
    batchId: uuid().primaryKey(),
    workspaceId: workspaceColumn(),
    flushedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [index().on(table.flushedAt), tenantIsolation()],
).enableRLS();

