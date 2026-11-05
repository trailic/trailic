import { sql } from "drizzle-orm";
import type { Database } from "./client";

/**
 * Whatever comes first: the work, or null once the wait is over. For what shouldn't hang on a database
 * that's stopped answering, since a driver waits for a frozen connection as long as it's asked to.
 */
export const withinTime = <T>(work: Promise<T>, waitMs: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

/** Long enough for a sleeping serverless database to wake, not long enough for a job to go nowhere for minutes. */
const WAKING_MS = 20_000;

/** Whether the database answers, before a job leans on it. */
export async function databaseAnswers(db: Database, waitMs = WAKING_MS): Promise<boolean> {
  const answered = await withinTime(
    (async () => {
      await db.execute(sql`select 1`);
      return true;
    })(),
    waitMs,
  ).catch(() => false);
  return answered === true;
}
