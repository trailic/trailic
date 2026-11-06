import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { siteIn, type SiteRow } from "@/application/sites";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm, ConfirmButton, CopyButton } from "@/components/try-button";
import { Card, Code, CodeBlock, FIELD, Labelled } from "@/components/ui";
import { when } from "@/components/when";
import { SIGN_IN_AREAS } from "@/domain/anonymous";
import { LIBRARY_INSTALL } from "@/domain/library";
import { LONGEST_RETENTION_DAYS, SHORTEST_RETENTION_DAYS } from "@/domain/sites";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { relayKeyOf } from "@/infrastructure/crypto/site-key";
import { db } from "@/infrastructure/db/client";
import { collectorEndpoint, collectorOrigin, env } from "@/infrastructure/env";
import { deleteSiteAction, rotateKeyAction, setAnonymousAction, updateSiteAction } from "../actions";

export const metadata: Metadata = { title: "Site" };

const snippetOf = (site: SiteRow, collector: string) => `// app/layout.tsx
import { Trailic } from "trailic";

// inside <body>, once:
<Trailic
  siteKey="${site.publicKey}"
  endpoint="${collector}"
/>`;

function Setup({ site, mayChange }: { site: SiteRow; mayChange: boolean }) {
  const settings = env();
  const snippet = snippetOf(site, collectorEndpoint(settings));
  const relayKey = settings.TRAILIC_SECRET ? relayKeyOf(site.id, settings.TRAILIC_SECRET) : null;
  return (
    <Card>
      <h2 className="font-semibold">Setup</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Until it’s on npm, install it from its release with <span className="font-mono text-xs break-all">{LIBRARY_INSTALL}</span>, then:
      </p>
      <div className="mt-3">
        <CodeBlock>{snippet}</CodeBlock>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CopyButton text={snippet} label="Copy the snippet" />
        {mayChange && <ConfirmButton action={rotateKeyAction.bind(null, site.id)} label="Replace the key" confirm="Yes: the old key stops collecting now" />}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">It sets no cookie and keeps nothing in the browser until a visitor objects or your site calls identify.</p>
      {relayKey && mayChange && (
        <details className="mt-4 text-sm text-muted-foreground">
          <summary className="cursor-pointer">Collecting through your own domain</summary>
          <p className="mt-2">Add a route at app/trailic/e/route.ts holding export const POST = trailicRelay(), from trailic/next, set endpoint to /trailic/e, and give the project these two variables:</p>
          <div className="mt-2 space-y-2">
            <Code>TRAILIC_URL={collectorOrigin(settings)}</Code>
            <Code>TRAILIC_RELAY_KEY={relayKey}</Code>
          </div>
          <p className="mt-2">The relay key lets that route say who the visitor is. Unlike the site key, it’s secret: it goes in the project’s environment, not in a page.</p>
        </details>
      )}
    </Card>
  );
}

const ANONYMOUS_ON = ["The visitor’s address is shortened before it goes into the day’s hash: IPv4 to /24, IPv6 to /48. People on one network with the same browser can then count as one visitor.", "UTM tags aren’t kept.", "identify is refused, and any user id or traits sent with an event are dropped, so nobody is followed from one day to the next.", `Sign-in, account and admin areas are never counted: ${SIGN_IN_AREAS.map((area) => `/${area}`).join(", ")}, after any locale at the start of the path.`];

const ANONYMOUS_OFF = ["The whole address goes into the day’s hash, and is then dropped. It’s never stored.", "UTM tags are kept, which campaign figures need.", "identify works, so funnels, retention and people can follow someone across days.", "Every page counts, sign-in and admin areas included."];

function ModeDescription({ title, current, lines }: { title: string; current: boolean; lines: string[] }) {
  return (
    <div className="mt-3 text-sm">
      <p className="font-medium">
        {title}
        {current && <span className="ml-2 font-normal text-muted-foreground">this site, now</span>}
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function AnonymousMode({ site, mayChange }: { site: SiteRow; mayChange: boolean }) {
  return (
    <Card>
      <h2 className="font-semibold">Anonymous mode</h2>
      <p className="mt-1 text-sm text-muted-foreground">How much is kept about each visitor. A change reaches the collector within a minute, and what was already collected stays as it is.</p>
      <ModeDescription title="On" current={site.anonymous} lines={ANONYMOUS_ON} />
      <ModeDescription title="Off" current={!site.anonymous} lines={ANONYMOUS_OFF} />
      <p className="mt-3 text-sm text-muted-foreground">Either way there’s no cookie, and figures are exact counts, not rounded: a page with very few visits can still be told apart. This setting decides what’s collected. What you owe your visitors, and whether you need their consent, is yours to work out.</p>
      {mayChange && (
        <div className="mt-3">
          <ConfirmButton action={setAnonymousAction.bind(null, site.id, !site.anonymous)} label={site.anonymous ? "Turn anonymous mode off" : "Turn anonymous mode on"} confirm={site.anonymous ? "Yes: keep UTM tags and allow identify" : "Yes: keep less from now on"} />
        </div>
      )}
    </Card>
  );
}

function Settings({ site }: { site: SiteRow }) {
  return (
    <Card>
      <h2 className="font-semibold">Settings</h2>
      <div className="mt-3">
        <ActionForm action={updateSiteAction.bind(null, site.id)} submit="Save" busy="…">
          <Labelled label="Name">
            <input name="name" required maxLength={80} defaultValue={site.name} className={FIELD} />
          </Labelled>
          <Labelled label="Domains" hint="One per line. Subdomains are included. A change reaches the collector within a minute.">
            <textarea name="domains" required rows={3} defaultValue={site.allowedDomains.join("\n")} className={FIELD} />
          </Labelled>
          <Labelled label="Keep raw events for, in days" hint={`Between ${SHORTEST_RETENTION_DAYS} and ${LONGEST_RETENTION_DAYS}. Funnels, journeys, retention and people read raw events; the overview’s daily figures stay for good.`}>
            <input name="retentionDays" type="number" required min={SHORTEST_RETENTION_DAYS} max={LONGEST_RETENTION_DAYS} defaultValue={site.retentionDays} className={FIELD} />
          </Labelled>
        </ActionForm>
      </div>
      <div className="mt-6 border-t pt-4">
        <p className="mb-2 text-sm text-muted-foreground">Deleting a site deletes everything it collected.</p>
        <ConfirmButton action={deleteSiteAction.bind(null, site.id)} label="Delete this site" confirm="Yes: delete it and all its data" />
      </div>
    </Card>
  );
}

async function Content({ params }: { params: PageProps<"/sites/[id]">["params"] }) {
  const { id } = await params;
  const seat = await currentSeat();
  const site = await siteIn(db(), seat.workspaceId, id);
  if (!site) notFound();
  const mayChange = managesSettings(seat.role);
  return (
    <>
      <PageHeading title={site.name}>{site.lastWrittenAt ? `Data last written ${when(site.lastWrittenAt)}.` : "Nothing written yet."}</PageHeading>
      <p className="-mt-5 mb-6 text-sm">
        <Link href={`/overview?site=${site.id}`} className="text-link hover:underline">
          See its figures
        </Link>
      </p>
      <div className="max-w-3xl space-y-4">
        <Setup site={site} mayChange={mayChange} />
        <AnonymousMode site={site} mayChange={mayChange} />
        {mayChange && <Settings site={site} />}
      </div>
    </>
  );
}

/** A site's key and setup snippet, and what can be changed about it. */
export default function SitePage({ params }: PageProps<"/sites/[id]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Content params={params} />
      </Suspense>
    </Shell>
  );
}
