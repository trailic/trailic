import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, tenantIsolation, workspaceColumn } from "./shared";
import { workspace } from "./tenancy";

/** A key another app reaches a workspace with; only its hash is kept. */
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceColumn().references(() => workspace.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** SHA-256 of the key, hex; the key itself is shown once, when it is made. */
    keyHash: text().notNull().unique(),
    /** The key's first characters, to tell keys apart in the list. */
    prefix: text().notNull(),
    /** What it may do (domain/api-scopes). */
    scopes: text().array().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index().on(table.workspaceId), tenantIsolation()],
).enableRLS();
