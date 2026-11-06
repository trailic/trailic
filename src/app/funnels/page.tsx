import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { funnelsOf } from "@/application/funnels";
import { sitesOf } from "@/application/sites";
import { chosenSite, NoSitesYet, SiteAndPeriod, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Card, FIELD, Labelled, ROWS } from "@/components/ui";
import { DEFAULT_WINDOW_HOURS, LONGEST_WINDOW_HOURS, stepLabel } from "@/domain/funnels";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { createFunnelAction } from "./actions";

export const metadata: Metadata = { title: "Funnels" };

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const seat = await currentSeat();
  const sites = await sitesOf(db(), seat.workspaceId);
  const site = chosenSite(sites, query);
  if (!site) return <NoSitesYet />;
  const funnels = await funnelsOf(db(), seat.workspaceId, site.id);
  return (
    <>
      <SiteAndPeriod action="/funnels" sites={sites} site={site} withPeriod={false} />
      <div className="max-w-3xl space-y-4">
        {funnels.length > 0 && (
          <ul className={ROWS}>
            {funnels.map((funnel) => (
              <li key={funnel.id} className="px-5 py-3 text-sm">
                <Link href={`/funnels/${funnel.id}`} className="font-medium hover:underline">
                  {funnel.name}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">{funnel.steps.map(stepLabel).join(" → ")}</p>
              </li>
            ))}
          </ul>
        )}
        <Card>
          <h2 className="mb-3 font-semibold">A new funnel on {site.name}</h2>
          <ActionForm action={createFunnelAction} submit="Save the funnel" busy="…">
            <input type="hidden" name="site" value={site.id} />
            <Labelled label="Name">
              <input name="name" required maxLength={80} placeholder="Sign-up" className={FIELD} />
            </Labelled>
            <Labelled label="Steps" hint="One per line, between two and eight. What starts with a slash is a page, and a trailing * matches anything under it. Anything else is a custom event’s name.">
              <textarea name="steps" required rows={4} placeholder={"/pricing\nsignup\n/welcome"} className={`${FIELD} font-mono`} />
            </Labelled>
            <Labelled label="Hours they have, from the first step" hint="A visitor nobody identified can only convert within a day: their hash rotates.">
              <input name="windowHours" type="number" required min={1} max={LONGEST_WINDOW_HOURS} defaultValue={DEFAULT_WINDOW_HOURS} className={FIELD} />
            </Labelled>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}

/** The funnels defined on a site, and a way to define another. */
export default function FunnelsPage({ searchParams }: PageProps<"/funnels">) {
  return (
    <Shell>
      <PageHeading title="Funnels">Steps people go through in order, and where they stop.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
