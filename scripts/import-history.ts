/**
 * Writes daily figures another tool counted into a site's rollups, marked as imported. For whoever
 * runs the instance, not for a member's key: API keys only read. Safe to run again.
 *
 *   TRAILIC_DATABASE_URL=… pnpm import-history history.ndjson --source "Another tool" --counts "all page views it recorded" [--note "…"] [--dry-run]
 *
 * One JSON object per line, a site's lines together, in docs/00-product.md's shape.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { importHistory, workspaceOfSite, type HistoryReport } from "@/application/history";
import { sitesInFile } from "@/domain/history";
import { connect } from "@/infrastructure/db/client";

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

const USAGE = 'Usage: pnpm import-history <file> --source "…" --counts "…" [--note "…"] [--dry-run]';

function argumentsGiven() {
  const file = process.argv[2];
  const source = option("source");
  const counts = option("counts");
  if (!file || file.startsWith("--") || !source || !counts) throw new Error(USAGE);
  return { file, source, counts, note: option("note"), dryRun: process.argv.includes("--dry-run") };
}

function reported(siteId: string, report: HistoryReport) {
  console.log(`${siteId}  ${report.status}  ${report.daysWritten} days written, ${report.daysHeldBack} held back, ${report.pageViews} page views, ${report.events} events, ${report.rows} rows`);
}

async function main() {
  const { file, source, counts, note, dryRun } = argumentsGiven();
  const db = connect(z.url().parse(process.env.TRAILIC_DATABASE_URL));
  const now = new Date();
  const totals = { sites: 0, unknown: 0, days: 0, pageViews: 0, events: 0, rows: 0 };
  for await (const { siteId, days } of sitesInFile(createInterface({ input: createReadStream(file) }))) {
    const workspaceId = await workspaceOfSite(db, siteId);
    if (!workspaceId) {
      totals.unknown += 1;
      console.log(`${siteId}  no such site`);
      continue;
    }
    const report = await importHistory(db, workspaceId, { siteId, source, counts, note, days }, now, { dryRun });
    reported(siteId, report);
    totals.sites += 1;
    totals.days += report.daysWritten;
    totals.pageViews += report.pageViews;
    totals.events += report.events;
    totals.rows += report.rows;
  }
  console.log(`${dryRun ? "Would write" : "Done"}: ${JSON.stringify(totals)}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
