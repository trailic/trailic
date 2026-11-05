import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { dayOf } from "@/domain/collected";
import type { Tried } from "@/domain/tried";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Database } from "@/infrastructure/db/client";
import { rowsOf } from "@/infrastructure/db/rows";
import { erasedPerson, event, person } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { personHash } from "./flush";
import { rebuildDays } from "./rollups";
import { roleIn } from "./team";

const PAGE = 100;
const ACTIVITY = 200;

const escapedLike = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/** Whoever this site identified, most recently seen first. */
export async function peopleOf(db: Database, workspaceId: string, siteId: string, search?: string) {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select()
      .from(person)
      .where(and(eq(person.siteId, siteId), search?.trim() ? ilike(person.userId, escapedLike(search.trim())) : undefined))
      .orderBy(desc(person.lastSeenAt))
      .limit(PAGE),
  );
}

export interface PersonActivity {
  person: typeof person.$inferSelect;
  events: { at: Date; kind: string; path: string | null; name: string | null; props: Record<string, unknown> | null; country: string | null; device: string | null; browser: string | null }[];
}

/** One person, and what they did lately. Raw rows: what's past the site's retention isn't here. */
export async function personActivity(db: Database, workspaceId: string, siteId: string, userId: string): Promise<PersonActivity | null> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [found] = await tx.select().from(person).where(and(eq(person.siteId, siteId), eq(person.userId, userId)));
    if (!found) return null;
    const events = await tx
      .select({ at: event.at, kind: event.kind, path: event.path, name: event.name, props: event.props, country: event.country, device: event.device, browser: event.browser })
      .from(event)
      .where(and(eq(event.siteId, siteId), eq(event.userId, userId)))
      .orderBy(desc(event.at))
      .limit(ACTIVITY);
    return { person: found, events };
  });
}

/**
 * Removes one person, for when they ask: their events, what they said about themselves, and their
 * part in the days those events were in. What's on its way in the buffer is dropped when it arrives,
 * by a hash of who they were kept for that long and no longer. If they come back and the site
 * identifies them again, that's new.
 */
export async function erasePerson(db: Database, workspaceId: string, actorId: string, siteId: string, userId: string, now: Date): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, actorId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  return withWorkspace(db, workspaceId, async (tx) => {
    const days = await rowsOf<{ at: string }>(tx, sql`delete from event where site_id = ${siteId}::uuid and user_id = ${userId} returning to_json(at)#>>'{}' as at`);
    const gone = await tx.delete(person).where(and(eq(person.siteId, siteId), eq(person.userId, userId))).returning({ id: person.userId });
    const userHash = personHash(siteId, userId);
    await tx.insert(erasedPerson).values({ siteId, userHash, erasedAt: now }).onConflictDoUpdate({ target: [erasedPerson.siteId, erasedPerson.userHash], set: { erasedAt: now } });
    await rebuildDays(tx, [...new Set(days.map(({ at }) => dayOf(at)))].map((day) => ({ siteId, day })));
    return gone.length > 0 || days.length > 0 ? { ok: true, said: `Erased: ${days.length} events and everything said about this person.` } : { ok: false, error: "There’s nobody by this id on this site." };
  });
}
