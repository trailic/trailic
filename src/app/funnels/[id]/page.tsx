import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { funnelIn, runFunnel } from "@/application/funnels";
import { siteIn } from "@/application/sites";
import { periodEndingAt } from "@/application/time-range";
import { counted, formatted, percent } from "@/components/charts";
import { daysIn, LastWritten, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ConfirmButton } from "@/components/try-button";
import { Card, INLINE_FIELD, QuietButton } from "@/components/ui";
import { stepLabel, type FunnelStepResult } from "@/domain/funnels";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { deleteFunnelAction } from "../actions";

export const metadata: Metadata = { title: "Funnel" };

function Step({ result, index }: { result: FunnelStepResult; index: number }) {
  return (
    <li data-step={index + 1}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className="min-w-0 truncate">
          <span className="mr-2 font-mono text-xs text-muted-foreground">{index + 1}</span>
          {stepLabel(result.step)}
        </span>
        <span className="font-mono text-xs">
          <span data-people className="text-foreground">{formatted(result.people)}</span> <span className="text-muted-foreground">{counted(result.people, "person", "people")} · {percent(result.conversion)}</span>
        </span>
      </div>
      <div className="mt-1 h-6 rounded-md bg-muted">
        <div className="h-full rounded-md bg-calm" style={{ width: `${result.conversion * 100}%` }} />
      </div>
      {index > 0 && <p className="mt-1 text-xs text-muted-foreground">{percent(result.dropOff)} dropped off here</p>}
    </li>
  );
}

async function Content({ params, searchParams }: { params: PageProps<"/funnels/[id]">["params"]; searchParams: Promise<Query> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const seat = await currentSeat();
  const funnel = await funnelIn(db(), seat.workspaceId, id);
  if (!funnel) notFound();
  const site = await siteIn(db(), seat.workspaceId, funnel.siteId);
  const days = daysIn(query);
  const report = await runFunnel(db(), seat.workspaceId, { siteId: funnel.siteId, steps: funnel.steps, windowHours: funnel.windowHours, period: periodEndingAt(new Date(), days) });
  return (
    <>
      <PageHeading title={funnel.name}>
        On {site?.name}, with {funnel.windowHours} hours from the first step. Someone anonymous can only convert within a day: their hash rotates.
      </PageHeading>
      <form className="mb-6 flex items-center gap-2">
        <input name="days" type="number" min={1} max={365} defaultValue={days} aria-label="Days back" className={`${INLINE_FIELD} w-24`} />
        <span className="text-sm text-muted-foreground">days back</span>
        <QuietButton type="submit">Show</QuietButton>
      </form>
      <Card className="max-w-3xl">
        <ol className="space-y-5">
          {report.steps.map((result, index) => (
            <Step key={index} result={result} index={index} />
          ))}
        </ol>
      </Card>
      <LastWritten at={report.lastWrittenAt} />
      <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
        <Link href={`/funnels?site=${funnel.siteId}`} className="text-link hover:underline">
          All funnels
        </Link>
        {managesSettings(seat.role) && <ConfirmButton action={deleteFunnelAction.bind(null, funnel.id)} label="Delete this funnel" confirm="Yes: delete it" />}
      </div>
    </>
  );
}

/** One funnel: how many reached each step, and how many stopped there. */
export default function FunnelPage({ params, searchParams }: PageProps<"/funnels/[id]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Content params={params} searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}

