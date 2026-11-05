import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { DEFAULT_WINDOW_HOURS, FUNNEL_STEPS, funnelResult, LONGEST_WINDOW_HOURS, pathPattern, type FunnelStepInput, type FunnelStepResult } from "@/domain/funnels";
import { managesSettings, NOT_A_MANAGER_OF_SETTINGS } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import type { Database } from "@/infrastructure/db/client";
import { rowsOf } from "@/infrastructure/db/rows";
import { funnel } from "@/infrastructure/db/schema/analytics";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { lastWrittenAt } from "./overview";
import { roleIn } from "./team";
import type { Period } from "./time-range";

export type FunnelRow = typeof funnel.$inferSelect;

export const funnelsOf = (db: Database, workspaceId: string, siteId: string): Promise<FunnelRow[]> => withWorkspace(db, workspaceId, (tx) => tx.select().from(funnel).where(eq(funnel.siteId, siteId)).orderBy(asc(funnel.name)));

export async function funnelIn(db: Database, workspaceId: string, id: string): Promise<FunnelRow | undefined> {
  const [found] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(funnel).where(eq(funnel.id, id)));
  return found;
}

export type SavedFunnel = { ok: true; id: string } | { ok: false; error: string };

export async function createFunnel(db: Database, workspaceId: string, input: { siteId: string; name: string; steps: unknown; windowHours?: number }): Promise<SavedFunnel> {
  const name = input.name.trim().slice(0, 80);
  if (!name) return { ok: false, error: "Give this funnel a name." };
  const steps = FUNNEL_STEPS.safeParse(input.steps);
  if (!steps.success) return { ok: false, error: "A funnel has between two and eight steps, each a page or an event." };
  const windowHours = Math.min(Math.max(Math.trunc(input.windowHours ?? DEFAULT_WINDOW_HOURS) || DEFAULT_WINDOW_HOURS, 1), LONGEST_WINDOW_HOURS);
  const made = await withWorkspace(db, workspaceId, (tx) => tx.insert(funnel).values({ siteId: input.siteId, name, steps: steps.data, windowHours }).onConflictDoNothing().returning({ id: funnel.id }));
  return made.length > 0 ? { ok: true, id: made[0].id } : { ok: false, error: "This site already has a funnel with this name." };
}

export async function deleteFunnel(db: Database, workspaceId: string, userId: string, id: string): Promise<Tried> {
  if (!managesSettings(await roleIn(db, workspaceId, userId))) return { ok: false, error: NOT_A_MANAGER_OF_SETTINGS };
  const gone = await withWorkspace(db, workspaceId, (tx) => tx.delete(funnel).where(and(eq(funnel.id, id))).returning({ id: funnel.id }));
  return gone.length > 0 ? { ok: true, said: "Funnel deleted." } : { ok: false, error: "This funnel is gone." };
}

function stepCondition({ kind, match }: FunnelStepInput): SQL {
  if (kind === "event") return sql`(e.kind = 'event' and e.name = ${match})`;
  const pattern = pathPattern(match);
  return "exact" in pattern ? sql`(e.kind = 'page' and e.path = ${pattern.exact})` : sql`(e.kind = 'page' and e.path like ${pattern.like})`;
}

const sameStep = (a: FunnelStepInput, b: FunnelStepInput) => a.kind === b.kind && a.match === b.match;

interface FunnelScope {
  siteId: string;
  windowHours: number;
  period: Pick<Period, "start" | "end">;
}

/** Who did this step in the period, and when. It reads through that step's own index, so a funnel's cost follows its steps, not the site's traffic. */
const whoDid = (step: FunnelStepInput, { siteId, period }: FunnelScope) => sql`
  select coalesce(e.user_id, e.visitor::text) as who, e.at
  from event e
  where e.site_id = ${siteId}::uuid and e.at >= ${period.start}::timestamptz and e.at < ${period.end}::timestamptz and ${stepCondition(step)} and coalesce(e.user_id, e.visitor::text) is not null`;

/**
 * Each step as who reached it and when: the earliest time after they reached the one before, inside
 * the window from their first step. A page view and an event in the same millisecond do happen, so
 * "after" includes the same moment, except for the same step twice, which must be a second visit.
 */
function stepChain(steps: readonly FunnelStepInput[], scope: FunnelScope): SQL {
  const chain = steps.map((step, index) => {
    const name = sql.raw(`step_${index}`);
    const rows = whoDid(step, scope);
    if (index === 0) return sql`${name} as (select who, min(at) as at, min(at) as started from (${rows}) e group by who)`;
    const previous = sql.raw(`step_${index - 1}`);
    const after = sameStep(step, steps[index - 1]) ? sql.raw(">") : sql.raw(">=");
    return sql`${name} as (select e.who, min(e.at) as at, min(p.started) as started from (${rows}) e join ${previous} p on p.who = e.who where e.at ${after} p.at and e.at <= p.started + make_interval(hours => ${scope.windowHours}) group by e.who)`;
  });
  return sql.join(chain, sql`, `);
}

/** How many people reached each step, against raw rows. */
async function countSteps(tx: Database, steps: readonly FunnelStepInput[], scope: FunnelScope): Promise<number[]> {
  const counts = sql.join(steps.map((_, index) => sql`(select count(*)::int from ${sql.raw(`step_${index}`)})`), sql`, `);
  const [row] = await rowsOf<{ counts: number[] }>(tx, sql`with ${stepChain(steps, scope)} select to_jsonb(array[${counts}]) as counts`);
  return row.counts;
}

export interface FunnelReport {
  from: string;
  to: string;
  timezone: "UTC";
  windowHours: number;
  lastWrittenAt: Date | null;
  steps: FunnelStepResult[];
}

/** Runs a funnel, saved or not. A visitor's hash lasts a day, so someone anonymous can only convert within one; an identified person across the whole window. */
export async function runFunnel(db: Database, workspaceId: string, input: { siteId: string; steps: readonly FunnelStepInput[]; windowHours?: number; period: Period }): Promise<FunnelReport> {
  const windowHours = input.windowHours ?? DEFAULT_WINDOW_HOURS;
  return withWorkspace(db, workspaceId, async (tx) => ({
    from: input.period.from,
    to: input.period.to,
    timezone: "UTC",
    windowHours,
    lastWrittenAt: await lastWrittenAt(tx, input.siteId),
    steps: funnelResult(input.steps, await countSteps(tx, input.steps, { siteId: input.siteId, windowHours, period: input.period })),
  }));
}
