import type { Database } from "@/infrastructure/db/client";
import { site } from "@/infrastructure/db/schema/analytics";

export interface ScheduledWork {
  /** With no site, nothing can arrive and nothing can age. */
  hasSites: boolean;
}

/** What the scheduled jobs have to do, across every workspace. Trusted path: it only ever says yes or no. */
export async function whatIsScheduled(db: Database): Promise<ScheduledWork> {
  const [any] = await db.select({ id: site.id }).from(site).limit(1);
  return { hasSites: Boolean(any) };
}
