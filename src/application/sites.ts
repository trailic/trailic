import { asc, eq } from "drizzle-orm";
import { DEFAULT_RETENTION_DAYS, parseDomains, validRetention } from "@/domain/sites";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { mintSiteKey } from "@/infrastructure/crypto/site-key";
import type { Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { roleIn } from "./team";

const NAME_LENGTH = 80;
export const NO_SECRET = "This instance’s TRAILIC_SECRET isn’t set, so it can’t issue site keys.";
const NO_DOMAIN = "Say which domain this site runs on: its pages can’t send from anywhere else.";

export type SiteRow = typeof site.$inferSelect;

export const sitesOf = (db: Database, workspaceId: string): Promise<SiteRow[]> => withWorkspace(db, workspaceId, (tx) => tx.select().from(site).orderBy(asc(site.name)));

/** One of this workspace's sites; row-level security answers for any other. */
export async function siteIn(db: Database, workspaceId: string, siteId: string): Promise<SiteRow | undefined> {
  if (!isUuid(siteId)) return undefined;
  const [found] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(site).where(eq(site.id, siteId)));
  return found;
}

/** Whether this looks like an id: what comes from an address shouldn't reach the database as a failed cast. */
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function domainsRefusal(typed: string): { domains: string[] } | { error: string } {
  const { domains, invalid } = parseDomains(typed);
  if (invalid.length > 0) return { error: `This isn’t a domain: ${invalid[0]}` };
  return domains.length > 0 ? { domains } : { error: NO_DOMAIN };
}

export type NewSite = { ok: true; id: string; key: string } | { ok: false; error: string };

export interface SiteInput {
  name: string;
  domains: string;
}

/** A new site and its public key. The key's secret is the instance's, and it's what lets the collector check it without this table. */
export async function createSite(db: Database, secret: string, workspaceId: string, userId: string, input: SiteInput): Promise<NewSite> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const name = input.name.trim().slice(0, NAME_LENGTH);
  if (!name) return { ok: false, error: "Give this site a name." };
  const parsed = domainsRefusal(input.domains);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const id = crypto.randomUUID();
  const key = mintSiteKey(id, secret);
  const made = await withWorkspace(db, workspaceId, (tx) => tx.insert(site).values({ id, name, publicKey: key, allowedDomains: parsed.domains, retentionDays: DEFAULT_RETENTION_DAYS }).onConflictDoNothing().returning({ id: site.id }));
  return made.length > 0 ? { ok: true, id, key } : { ok: false, error: "This workspace already has a site with this name." };
}

export interface SiteChanges {
  name?: string;
  domains?: string;
  retentionDays?: unknown;
  anonymous?: boolean;
}

export async function updateSite(db: Database, workspaceId: string, userId: string, siteId: string, changes: SiteChanges): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const parsed = changes.domains === undefined ? null : domainsRefusal(changes.domains);
  if (parsed && "error" in parsed) return { ok: false, error: parsed.error };
  const retentionDays = changes.retentionDays === undefined ? undefined : validRetention(changes.retentionDays);
  if (retentionDays === null) return { ok: false, error: "Keep raw events for between 14 and 730 days." };
  const updated = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(site)
      .set({ ...(changes.name?.trim() ? { name: changes.name.trim().slice(0, NAME_LENGTH) } : {}), ...(parsed ? { allowedDomains: parsed.domains } : {}), ...(retentionDays ? { retentionDays } : {}), ...(changes.anonymous === undefined ? {} : { anonymous: changes.anonymous }) })
      .where(eq(site.id, siteId))
      .returning({ id: site.id }),
  );
  return updated.length > 0 ? { ok: true, said: "Saved." } : { ok: false, error: "This site is gone." };
}

/** A new key, which ends the old one: for a key that's being abused. Every page has to be given the new one. */
export async function rotateSiteKey(db: Database, secret: string, workspaceId: string, userId: string, siteId: string): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const replaced = await withWorkspace(db, workspaceId, (tx) => tx.update(site).set({ publicKey: mintSiteKey(siteId, secret) }).where(eq(site.id, siteId)).returning({ id: site.id }));
  return replaced.length > 0 ? { ok: true, said: "This site has a new key. The old one no longer collects anything." } : { ok: false, error: "This site is gone." };
}

/** Deletes a site and everything it collected; its events, rollups and people go with it. */
export async function deleteSite(db: Database, workspaceId: string, userId: string, siteId: string): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const deleted = await withWorkspace(db, workspaceId, (tx) => tx.delete(site).where(eq(site.id, siteId)).returning({ id: site.id }));
  return deleted.length > 0 ? { ok: true, said: "Site deleted." } : { ok: false, error: "This site is gone." };
}

export interface DirectoryEntry {
  siteId: string;
  key: string;
  allowedDomains: string[];
  anonymous: boolean;
}

/** What the collector needs to know about every site, across all workspaces. Trusted path: it only ever says who may send. */
export const collectorDirectory = (db: Database): Promise<DirectoryEntry[]> => db.select({ siteId: site.id, key: site.publicKey, allowedDomains: site.allowedDomains, anonymous: site.anonymous }).from(site);

