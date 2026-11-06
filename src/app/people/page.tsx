import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { peopleOf } from "@/application/people";
import { sitesOf } from "@/application/sites";
import { chosenSite, NoSitesYet, oneOf, SiteAndPeriod, type Query } from "@/components/reading";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { EmptyState, INLINE_FIELD, ROWS } from "@/components/ui";
import { when } from "@/components/when";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export const metadata: Metadata = { title: "People" };

const traitsOf = (traits: Record<string, unknown>) =>
  Object.entries(traits)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join(", ");

async function Content({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const seat = await currentSeat();
  const sites = await sitesOf(db(), seat.workspaceId);
  const site = chosenSite(sites, query);
  if (!site) return <NoSitesYet />;
  const search = oneOf(query, "q");
  const people = await peopleOf(db(), seat.workspaceId, site.id, search);
  return (
    <>
      <SiteAndPeriod action="/people" sites={sites} site={site} withPeriod={false}>
        <input name="q" defaultValue={search} placeholder="Find by id" aria-label="Find by id" className={`${INLINE_FIELD} min-w-48`} />
      </SiteAndPeriod>
      {people.length === 0 ? (
        <EmptyState className="max-w-2xl">{search ? "Nobody by that id." : "Nobody identified yet. Someone appears here once the site calls identify."}</EmptyState>
      ) : (
        <ul className={ROWS}>
          {people.map(({ userId, traits, lastSeenAt, firstSeenAt }) => (
            <li key={userId} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <Link href={`/people/${site.id}/${encodeURIComponent(userId)}`} className="font-medium hover:underline">
                {userId}
              </Link>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{traitsOf(traits)}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                First {when(firstSeenAt)} · last {when(lastSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Whoever a site identified. */
export default function PeoplePage({ searchParams }: PageProps<"/people">) {
  return (
    <Shell>
      <PageHeading title="People">Those your sites identified. Anonymous visitors aren’t here: nothing could tell one from another the next day.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
