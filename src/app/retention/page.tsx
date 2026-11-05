import type { Metadata } from "next";
import { Suspense } from "react";
import { DEFAULT_WEEKS, MOST_WEEKS, retentionOf, type RetentionTable } from "@/application/cohorts";
import { sitesOf } from "@/application/sites";
import { formatted, percent } from "@/components/charts";
import { chosenSite, LastWritten, NoSitesYet, oneOf, SiteAndPeriod, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { INLINE_FIELD } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export const metadata: Metadata = { title: "Retention" };

const weekName = (week: string) => new Date(`${week}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** A cohort's week: the share that came back, darker for more. The number stays in the text's own colour, so it reads at any shade. */
function Cell({ people, size }: { people: number; size: number }) {
  const share = size === 0 ? 0 : people / size;
  return (
    <td title={`${formatted(people)} of ${formatted(size)}`} className="px-0.5 py-0.5">
      <div className="rounded-md px-2 py-1.5 text-center font-mono text-xs" style={{ background: `color-mix(in oklab, var(--calm) ${Math.round(share * 55)}%, transparent)` }}>
        {size === 0 ? "" : percent(share)}
      </div>
    </td>
  );
}

function Cohorts({ table }: { table: RetentionTable }) {
  return (
    <div className="overflow-x-auto rounded-2xl border bg-card p-4">
      <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="px-2 pb-2 text-left font-normal">First seen, week of</th>
            <th className="px-2 pb-2 text-right font-normal">People</th>
            {Array.from({ length: table.weeks }, (_, offset) => (
              <th key={offset} className="w-16 px-0.5 pb-2 text-center font-normal">
                {offset === 0 ? "That week" : `+${offset}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.cohorts.map(({ week, size, returned }) => (
            <tr key={week} data-cohort={week}>
              <td className="px-2 py-0.5 whitespace-nowrap">{weekName(week)}</td>
              <td data-size className="px-2 py-0.5 text-right font-mono text-xs">{formatted(size)}</td>
              {returned.map((people, offset) => (
                <Cell key={offset} people={people} size={size} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const seat = await currentSeat();
  const sites = await sitesOf(db(), seat.workspaceId);
  const site = chosenSite(sites, query);
  if (!site) return <NoSitesYet />;
  const weeks = Math.min(Math.max(Math.trunc(Number(oneOf(query, "weeks"))) || DEFAULT_WEEKS, 2), MOST_WEEKS);
  const event = oneOf(query, "event")?.trim() || undefined;
  const table = await retentionOf(db(), seat.workspaceId, { siteId: site.id, weeks, eventName: event, now: new Date() });
  return (
    <>
      <SiteAndPeriod action="/retention" sites={sites} site={site} withPeriod={false}>
        <select name="weeks" defaultValue={String(weeks)} aria-label="Weeks" className={INLINE_FIELD}>
          {[...new Set([4, 8, 12, 26, weeks])]
            .sort((a, b) => a - b)
            .map((count) => (
              <option key={count} value={count}>
                {count} weeks
              </option>
            ))}
        </select>
        <input name="event" defaultValue={event} placeholder="Any activity, or an event’s name" aria-label="What counts as coming back" className={`${INLINE_FIELD} min-w-64`} />
      </SiteAndPeriod>
      <Cohorts table={table} />
      <LastWritten at={table.lastWrittenAt} />
    </>
  );
}

/** Who comes back, by the week they first appeared. */
export default function RetentionPage({ searchParams }: PageProps<"/retention">) {
  return (
    <Shell>
      <PageHeading title="Retention">Identified people only: an anonymous visitor’s hash rotates every day, on purpose, so nobody can recognise them a week later. Your site’s identify calls are what make this possible.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
