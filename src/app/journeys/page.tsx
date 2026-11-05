import type { Metadata } from "next";
import { Suspense } from "react";
import { journeysOf, type JourneysReport } from "@/application/journeys";
import { topValues } from "@/application/overview";
import { sitesOf } from "@/application/sites";
import { periodEndingAt } from "@/application/time-range";
import { counted, formatted, percent } from "@/components/charts";
import { chosenSite, daysIn, LastWritten, NoSitesYet, oneOf, SiteAndPeriod, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, INLINE_FIELD } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { withWorkspace } from "@/infrastructure/db/tenant";

export const metadata: Metadata = { title: "Journeys" };

function Paths({ report }: { report: JourneysReport }) {
  if (report.journeys.length === 0) return <Card className="max-w-2xl text-sm text-muted-foreground">Nobody reached {report.start} in this period.</Card>;
  return (
    <Card className="max-w-4xl">
      <p className="mb-3 text-sm text-muted-foreground">
        <span data-visits className="font-mono text-foreground">{formatted(report.visits)}</span> {counted(report.visits, "visit", "visits")} reached <span className="font-mono text-foreground">{report.start}</span>, once per visitor per day. Then, within half an hour:
      </p>
      <ul className="space-y-1">
        {report.journeys.map(({ next, visits }) => (
          <li key={next.join("\n")} data-journey={next.join(" ") || "(left)"} className="relative flex items-center justify-between gap-3 rounded-md px-2 py-1 text-sm">
            <span aria-hidden className="absolute inset-y-0 left-0 rounded-md bg-calm/15" style={{ width: `${(visits / report.visits) * 100}%` }} />
            <span className="relative min-w-0 truncate">{next.length > 0 ? next.join(" → ") : <span className="text-muted-foreground">Went no further</span>}</span>
            <span className="relative shrink-0 font-mono text-xs text-muted-foreground">
              <span className="text-foreground">{formatted(visits)}</span> · {percent(visits / report.visits)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const seat = await currentSeat();
  const sites = await sitesOf(db(), seat.workspaceId);
  const site = chosenSite(sites, query);
  if (!site) return <NoSitesYet />;
  const days = daysIn(query);
  const period = periodEndingAt(new Date(), days);
  const pages = await withWorkspace(db(), seat.workspaceId, (tx) => topValues(tx, site.id, "page", period, 30));
  const from = oneOf(query, "from")?.trim() || pages[0]?.value;
  const report = from ? await journeysOf(db(), seat.workspaceId, { siteId: site.id, startPath: from, period }) : null;
  return (
    <>
      <SiteAndPeriod action="/journeys" sites={sites} site={site} days={days}>
        <input name="from" list="pages" defaultValue={from} placeholder="/pricing" aria-label="From this page" className={`${INLINE_FIELD} min-w-64 font-mono`} />
        <datalist id="pages">
          {pages.map(({ value }) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </SiteAndPeriod>
      {report ? <Paths report={report} /> : <Card className="max-w-2xl text-sm text-muted-foreground">No page views in this period.</Card>}
      {report && <LastWritten at={report.lastWrittenAt} />}
    </>
  );
}

/** Where people go from a page. */
export default function JourneysPage({ searchParams }: PageProps<"/journeys">) {
  return (
    <Shell>
      <PageHeading title="Journeys">The most common paths onward from a page: the next three pages, within half an hour.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
