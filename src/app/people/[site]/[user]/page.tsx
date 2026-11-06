import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { personActivity, type PersonActivity } from "@/application/people";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ConfirmButton } from "@/components/try-button";
import { Card, ROWS } from "@/components/ui";
import { when } from "@/components/when";
import { isUuid } from "@/application/sites";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { erasePersonAction } from "../../actions";

export const metadata: Metadata = { title: "Person" };

const WHAT: Record<string, (event: PersonActivity["events"][number]) => string> = {
  page: ({ path }) => `Visited ${path}`,
  event: ({ name }) => `Did ${name}`,
  identify: () => "Identified",
  vital: ({ name }) => `Measured ${name}`,
};

function Activity({ events }: { events: PersonActivity["events"] }) {
  if (events.length === 0) return <Card className="text-sm text-muted-foreground">Nothing recent: what they did is past this site’s retention.</Card>;
  return (
    <ul className={ROWS}>
      {events.map((event, index) => (
        <li key={index} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-2 text-sm">
          <span className="min-w-0 truncate">{WHAT[event.kind](event)}</span>
          {event.props && <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{JSON.stringify(event.props)}</span>}
          <span className="ml-auto font-mono text-xs text-muted-foreground">{when(event.at)}</span>
        </li>
      ))}
    </ul>
  );
}

async function Content({ params }: { params: PageProps<"/people/[site]/[user]">["params"] }) {
  const { site, user } = await params;
  const userId = decodeURIComponent(user);
  const seat = await currentSeat();
  const found = isUuid(site) ? await personActivity(db(), seat.workspaceId, site, userId) : null;
  if (!found) notFound();
  return (
    <>
      <PageHeading title={userId}>
        First seen {when(found.person.firstSeenAt)}, last seen {when(found.person.lastSeenAt)}.
      </PageHeading>
      <div className="max-w-3xl space-y-4">
        {Object.keys(found.person.traits).length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold">What the site said about them</h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {Object.entries(found.person.traits).map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="min-w-0 break-words">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}
        <h2 className="pt-2 text-sm font-semibold">Recent activity</h2>
        <Activity events={found.events} />
        {managesSettings(seat.role) && (
          <Card>
            <h2 className="font-semibold">Erase this person</h2>
            <p className="mt-1 mb-3 text-sm text-muted-foreground">For when they ask. Removes their events and what the site said about them, takes them out of the days’ figures while those days’ raw events remain, and stops what’s still on its way. It can’t be undone. If your site identifies them again, they’re someone new.</p>
            <ConfirmButton action={erasePersonAction.bind(null, site, userId)} label="Erase this person" confirm="Yes: erase everything about them" />
          </Card>
        )}
        <p className="text-sm">
          <Link href={`/people?site=${site}`} className="text-link hover:underline">
            All people
          </Link>
        </p>
      </div>
    </>
  );
}

/** One person's recent activity, and the way to erase them. */
export default function PersonPage({ params }: PageProps<"/people/[site]/[user]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Content params={params} />
      </Suspense>
    </Shell>
  );
}
