import type { SQL } from "drizzle-orm";
import type { Database } from "./client";

/** The rows of a raw statement, whichever driver ran it: postgres-js answers an array, PGlite an object holding one. */
export async function rowsOf<T>(db: Database, statement: SQL): Promise<T[]> {
  const result = (await db.execute(statement)) as unknown;
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}
