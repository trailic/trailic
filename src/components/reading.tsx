import Form from "next/form";
import Link from "next/link";
import type { ReactNode } from "react";
import { boundedDays } from "@/application/time-range";
import type { SiteRow } from "@/application/sites";
import { when } from "./when";
import { EmptyState, INLINE_FIELD, QuietButton } from "./ui";

export type Query = Record<string, string | string[] | undefined>;

export const oneOf = (query: Query, name: string) => (typeof query[name] === "string" ? (query[name] as string) : undefined);

const PERIODS = [7, 30, 90, 365];

export const daysIn = (query: Query) => boundedDays(oneOf(query, "days"));

/** The site a page asked for, among this workspace's: otherwise the first, or none when `orAll` lets it read them all. */
export function chosenSite(sites: readonly SiteRow[], query: Query, orAll = false): SiteRow | undefined {
  const wanted = sites.find(({ id }) => id === oneOf(query, "site"));
  return wanted ?? (orAll ? undefined : sites[0]);
}

/** Which site and how far back, at the top of every page that reads figures. */
export function SiteAndPeriod({ action, sites, site, days, allSites = false, withPeriod = true, children }: { action: string; sites: readonly SiteRow[]; site?: SiteRow; days?: number; allSites?: boolean; withPeriod?: boolean; children?: ReactNode }) {
  return (
    <Form action={action} className="mb-6 flex flex-wrap items-center gap-2">
      <select name="site" defaultValue={site?.id ?? ""} aria-label="Site" className={INLINE_FIELD}>
        {allSites && <option value="">All sites</option>}
        {sites.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {withPeriod && (
        <select name="days" defaultValue={String(days)} aria-label="Period" className={INLINE_FIELD}>
          {[...new Set([...PERIODS, days ?? 30])]
            .sort((a, b) => a - b)
            .map((length) => (
              <option key={length} value={length}>
                Last {length} days
              </option>
            ))}
        </select>
      )}
      {children}
      <QuietButton type="submit">Show</QuietButton>
    </Form>
  );
}

/** How old what's on screen is. Events wait in a buffer and reach the database on the hour, so "now" would be a lie. */
export function LastWritten({ at }: { at: Date | null }) {
  return <p className="mt-6 font-mono text-xs text-muted-foreground">{at ? `Data last written ${when(at)}. New events reach it on the hour.` : "Nothing written yet. Events reach the database on the hour."}</p>;
}

/** For a page with nothing to read, because there's nothing to measure yet. */
export function NoSitesYet() {
  return (
    <EmptyState title="No site yet" className="max-w-xl">
      <Link href="/sites" className="text-link hover:underline">
        Add your first
      </Link>{" "}
      and put its snippet in your layout.
    </EmptyState>
  );
}
