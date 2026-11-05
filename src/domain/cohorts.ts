/** Retention laid out as a table. Pure: the database says how many came back in which week of which cohort. */

export interface CohortCell {
  cohort: string;
  /** Whole weeks after the cohort's first. */
  offset: number;
  people: number;
}

export interface CohortRow {
  /** The Monday this cohort was first seen, YYYY-MM-DD, UTC. */
  week: string;
  size: number;
  /** One number per week since, up to the current one: how many came back that week. */
  returned: number[];
}

const WEEK_MS = 7 * 86_400_000;

/** The Monday of a date's week, in UTC. */
export function weekOf(at: Date): string {
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - sinceMonday)).toISOString().slice(0, 10);
}

/** The Mondays of the last weeks, oldest first, this week included. */
export function weeksEndingAt(now: Date, weeks: number): string[] {
  const thisWeek = new Date(`${weekOf(now)}T00:00:00Z`).getTime();
  return Array.from({ length: weeks }, (_, index) => new Date(thisWeek - (weeks - 1 - index) * WEEK_MS).toISOString().slice(0, 10));
}

export function cohortTable(weeks: readonly string[], sizes: ReadonlyMap<string, number>, cells: readonly CohortCell[]): CohortRow[] {
  const returned = new Map(cells.map(({ cohort, offset, people }) => [`${cohort}+${offset}`, people]));
  return weeks.map((week, position) => ({
    week,
    size: sizes.get(week) ?? 0,
    returned: Array.from({ length: weeks.length - position }, (_, offset) => returned.get(`${week}+${offset}`) ?? 0),
  }));
}
