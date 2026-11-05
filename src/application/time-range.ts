import { dayOf, daysEndingAt } from "@/domain/collected";

/** A period of whole UTC days ending today: what every screen and tool reads. */
export interface Period {
  from: string;
  to: string;
  days: string[];
  /** Bounds for raw rows, as ISO moments: postgres-js won't take a Date inside a raw statement. */
  start: string;
  end: string;
}

export const LONGEST_PERIOD_DAYS = 365;

export const boundedDays = (days: unknown, fallback = 30) => Math.min(Math.max(Math.trunc(Number(days)) || fallback, 1), LONGEST_PERIOD_DAYS);

export function periodEndingAt(now: Date, length: number): Period {
  const days = daysEndingAt(now, length);
  const to = dayOf(now);
  return { from: days[0], to, days, start: `${days[0]}T00:00:00.000Z`, end: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString() };
}
