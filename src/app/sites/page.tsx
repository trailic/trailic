import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { sitesOf } from "@/application/sites";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ActionForm } from "@/components/try-button";
import { Card, FIELD, Labelled, ROWS } from "@/components/ui";
import { when } from "@/components/when";
import { managesSettings } from "@/domain/team";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { createSiteAction } from "./actions";

export const metadata: Metadata = { title: "Sites" };

async function Sites() {
  const seat = await currentSeat();
  const sites = await sitesOf(db(), seat.workspaceId);
  return (
    <div className="max-w-3xl space-y-4">
      {sites.length > 0 && (
        <ul className={ROWS}>
          {sites.map((site) => (
            <li key={site.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <Link href={`/sites/${site.id}`} className="font-medium hover:underline">
                {site.name}
              </Link>
              <span className="text-xs text-muted-foreground">{site.allowedDomains.join(", ")}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">{site.lastWrittenAt ? `Written ${when(site.lastWrittenAt)}` : "Nothing yet"}</span>
            </li>
          ))}
        </ul>
      )}
      <Card>
        <h2 className="mb-3 font-semibold">{sites.length > 0 ? "Add a site" : "Add your first site"}</h2>
        {managesSettings(seat.role) ? (
          <ActionForm action={createSiteAction} submit="Add the site" busy="…">
            <Labelled label="Name">
              <input name="name" required maxLength={80} placeholder="Acme shop" className={FIELD} />
            </Labelled>
            <Labelled label="Domains" hint="One per line. Subdomains are included: its pages can’t send from anywhere else.">
              <textarea name="domains" required rows={2} placeholder="shop.acme.example" className={FIELD} />
            </Labelled>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted-foreground">Only owners and admins add sites.</p>
        )}
      </Card>
    </div>
  );
}

/** What this workspace measures, and where to add another. */
export default function SitesPage() {
  return (
    <Shell>
      <PageHeading title="Sites">Each has its own key, its own domains and its own figures.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Sites />
      </Suspense>
    </Shell>
  );
}
