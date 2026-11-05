import type { Metadata } from "next";
import { Suspense } from "react";
import { overviewOf, type Overview, type VitalFigure } from "@/application/overview";
import { sitesOf } from "@/application/sites";
import { periodEndingAt } from "@/application/time-range";
import { DayColumns, formatted, percent, TopList } from "@/components/charts";
import { chosenSite, daysIn, LastWritten, NoSitesYet, SiteAndPeriod, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card } from "@/components/ui";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export const metadata: Metadata = { title: "Overview" };

function Totals({ totals }: { totals: Overview["totals"] }) {
  const figures = [
    { label: "Visitors", value: formatted(totals.visitors) },
    { label: "Page views", value: formatted(totals.pageViews) },
    { label: "Events", value: formatted(totals.events) },
    { label: "Bounce rate", value: totals.visitors === 0 ? "None yet" : percent(totals.bounces / totals.visitors) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {figures.map(({ label, value }) => (
        <Card key={label} className="py-4">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd data-figure={label} className="mt-1 text-2xl font-semibold tracking-[-0.03em]">
            {value}
          </dd>
        </Card>
      ))}
    </dl>
  );
}

const VITAL_UNITS: Record<string, string> = { LCP: "ms", INP: "ms", CLS: "" };

function WebVitals({ vitals }: { vitals: VitalFigure[] }) {
  if (vitals.length === 0) return null;
  return (
    <Card className="mt-4">
      <h2 className="text-sm font-semibold tracking-[-0.02em]">Web vitals, 75th percentile</h2>
      <ul className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-sm">
        {vitals.map(({ metric, p75, samples }) => (
          <li key={metric}>
            <span className="text-muted-foreground">{metric}</span> <span className="font-mono">{Number(p75.toFixed(3))}{VITAL_UNITS[metric] ?? ""}</span> <span className="text-xs text-muted-foreground">from {formatted(samples)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Figures({ overview }: { overview: Overview }) {
  const utm = [
    { title: "UTM source", rows: overview.utm.source },
    { title: "UTM medium", rows: overview.utm.medium },
    { title: "UTM campaign", rows: overview.utm.campaign },
    { title: "UTM term", rows: overview.utm.term },
    { title: "UTM content", rows: overview.utm.content },
  ].filter(({ rows }, index) => rows.length > 0 || index === 0);
  return (
    <>
      <Totals totals={overview.totals} />
      <Card className="mt-4">
        <h2 className="mb-3 text-sm font-semibold tracking-[-0.02em]">Page views</h2>
        <DayColumns days={overview.days.map(({ date, pageViews }) => ({ date, value: pageViews }))} measure="Page views" />
      </Card>
      <Card className="mt-4">
        <div className="grid gap-8 md:grid-cols-2">
          <TopList title="Pages" rows={overview.pages} />
          <TopList title="Referrers" rows={overview.referrers} />
          {utm.map(({ title, rows }) => (
            <TopList key={title} title={title} rows={rows} empty="No campaign tags yet." />
          ))}
          <TopList title="Countries" rows={overview.countries} />
          <TopList title="Devices" rows={overview.devices} />
          <TopList title="Browsers" rows={overview.browsers} />
          <TopList title="Systems" rows={overview.systems} />
        </div>
      </Card>
      <WebVitals vitals={overview.vitals} />
      <LastWritten at={overview.lastWrittenAt} />
    </>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const seat = await currentSeat();
  const sites = await sitesOf(db(), seat.workspaceId);
  if (sites.length === 0) return <NoSitesYet />;
  const site = chosenSite(sites, query, true);
  const days = daysIn(query);
  const overview = await overviewOf(db(), seat.workspaceId, site?.id ?? null, periodEndingAt(new Date(), days));
  return (
    <>
      <SiteAndPeriod action="/overview" sites={sites} site={site} days={days} allSites />
      <Figures overview={overview} />
    </>
  );
}

/** What replaces a hosted dashboard, for one site or all of a workspace's. */
export default function OverviewPage({ searchParams }: PageProps<"/overview">) {
  return (
    <Shell>
      <PageHeading title="Overview">A visitor is counted once per site per day: the hash that counts them rotates at midnight, UTC.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
