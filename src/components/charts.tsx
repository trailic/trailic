import type { TopValue } from "@/application/overview";

const number = new Intl.NumberFormat("en-GB");
export const formatted = (value: number) => number.format(value);
/** A word that agrees with its number: "1 person", "2 people". */
export const counted = (count: number, one: string, many: string) => (count === 1 ? one : many);
export const percent = (share: number) => `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`;

const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export interface DayValue {
  date: string;
  value: number;
  /** Another tool counted this day: drawn paler, and said in words wherever it's read out. */
  imported?: boolean;
}

function columnColour({ value, imported }: DayValue, most: number): string {
  if (value === most) return imported ? "bg-blaze/45" : "bg-blaze";
  return imported ? "bg-data/35" : "bg-data";
}

const importedWord = (imported?: boolean) => (imported ? ", imported" : "");

/**
 * One measure over days, as columns growing from one baseline, with the busiest day, which the scale reads, in
 * the trail's colour. Each column's whole height answers
 * the pointer, since a quiet day's mark is too small to aim at, and the numbers are one click away as
 * a table, so nothing depends on seeing the chart.
 */
export function DayColumns({ days, measure }: { days: DayValue[]; measure: string }) {
  const most = Math.max(...days.map(({ value }) => value), 1);
  return (
    <figure>
      <figcaption className="sr-only">
        {measure} per day, {dayLabel(days[0].date)} to {dayLabel(days[days.length - 1].date)}
      </figcaption>
      <div className="flex h-40 border-b">
        <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{formatted(most)}</span>
        <div className="flex min-w-0 flex-1 items-end gap-0.5">
          {days.map(({ date, value, imported }) => (
            <div key={date} tabIndex={0} aria-label={`${dayLabel(date)}: ${formatted(value)}${importedWord(imported)}`} className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none">
              <div className={`w-full max-w-6 rounded-t-[3px] transition-colors group-hover:bg-blaze group-focus:bg-blaze ${columnColour({ date, value, imported }, most)}`} style={{ height: `${(value / most) * 100}%` }} />
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground group-hover:block group-focus:block">
                {dayLabel(date)}: <span className="font-mono">{formatted(value)}</span>
                {importedWord(imported)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 ml-14 flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{dayLabel(days[0].date)}</span>
        <span>{dayLabel(days[days.length - 1].date)}</span>
      </div>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">As a table</summary>
        <table className="mt-2 w-full max-w-xs">
          <tbody>
            {days.map(({ date, value, imported }) => (
              <tr key={date}>
                <td className="py-0.5">
                  {dayLabel(date)}
                  {importedWord(imported)}
                </td>
                <td className="py-0.5 text-right font-mono text-foreground">{formatted(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** A small one for a row in a list: the shape of its days, nothing to read off it. */
export function MiniColumns({ days }: { days: DayValue[] }) {
  const most = Math.max(...days.map(({ value }) => value), 1);
  return (
    <span aria-hidden className="flex h-6 w-28 shrink-0 items-end gap-px">
      {days.map(({ date, value }) => (
        <span key={date} title={`${dayLabel(date)}: ${formatted(value)}`} className="min-w-0 flex-1 rounded-t-[2px] bg-data" style={{ height: value === 0 ? "1px" : `${(value / most) * 100}%`, opacity: value === 0 ? 0.25 : 1 }} />
      ))}
    </span>
  );
}

/** The biggest values of something, each with a bar behind it that the words stay readable over. */
export function TopList({ title, rows, countName = "views", empty = "Nothing yet." }: { title: string; rows: TopValue[]; countName?: string; empty?: string }) {
  const most = Math.max(...rows.map(({ count }) => count), 1);
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-normal">{title}</h2>
        {rows.length > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {countName} · visitors
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={`${row.siteName ?? ""}${row.value}`} title={`${row.value}: ${formatted(row.count)} ${countName}, ${formatted(row.visitors)} visitors`} className="relative flex items-center justify-between gap-3 rounded-md px-2 py-1 text-sm">
              <span aria-hidden className="absolute inset-y-0 left-0 rounded-md bg-data/8" style={{ width: `${(row.count / most) * 100}%` }} />
              <span className="relative min-w-0 truncate">
                {row.value}
                {row.siteName && <span className="ml-2 text-xs text-muted-foreground">{row.siteName}</span>}
              </span>
              <span className="relative shrink-0 font-mono text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{formatted(row.count)}</span> · {formatted(row.visitors)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
