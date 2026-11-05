import type { Metadata } from "next";
import { Suspense } from "react";
import { customEventsOf } from "@/application/custom-events";
import { sitesOf } from "@/application/sites";
import { periodEndingAt } from "@/application/time-range";
import { counted, formatted, MiniColumns } from "@/components/charts";
import { chosenSite, daysIn, LastWritten, NoSitesYet, SiteAndPeriod, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, CodeBlock } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export const metadata: Metadata = { title: "Events" };

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const seat = await currentSeat();
  const sites = await sitesOf(db(), seat.workspaceId);
  if (sites.length === 0) return <NoSitesYet />;
  const site = chosenSite(sites, query, true);
  const days = daysIn(query);
  const { events, lastWrittenAt } = await customEventsOf(db(), seat.workspaceId, site?.id ?? null, periodEndingAt(new Date(), days));
  return (
    <>
      <SiteAndPeriod action="/events" sites={sites} site={site} days={days} allSites />
      {events.length === 0 ? (
        <Card className="max-w-2xl">
          <p className="text-sm text-muted-foreground">No custom events in this period. Send one from your site:</p>
          <div className="mt-3">
            <CodeBlock>{`import { track } from "trailic";\n\ntrack("signup", { plan: "pro" });`}</CodeBlock>
          </div>
        </Card>
      ) : (
        <ul className="divide-y rounded-2xl border bg-card">
          {events.map((event) => (
            <li key={event.name} data-event={event.name} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{event.name}</span>
              <MiniColumns days={event.days.map(({ date, count }) => ({ date, value: count }))} />
              <span className="w-24 text-right font-mono text-xs">
                <span className="text-foreground">{formatted(event.count)}</span> <span className="text-muted-foreground">{counted(event.count, "time", "times")}</span>
              </span>
              <span className="w-28 text-right font-mono text-xs text-muted-foreground">{formatted(event.visitors)} {counted(event.visitors, "visitor", "visitors")}</span>
            </li>
          ))}
        </ul>
      )}
      <LastWritten at={lastWrittenAt} />
    </>
  );
}

/** What sites record beyond page views. */
export default function EventsPage({ searchParams }: PageProps<"/events">) {
  return (
    <Shell>
      <PageHeading title="Custom events">What your sites record with track(), most frequent first.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
