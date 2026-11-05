import { flushBuffer } from "@/application/flush";
import { eventBuffer } from "@/infrastructure/buffer";
import { db } from "@/infrastructure/db/client";
import { cronRefusal, knownWork } from "../scheduled-work";

/** Writes what's in the buffer to the database. With no site, or an empty buffer, it answers without touching the database. */
export async function GET(request: Request) {
  const refusal = cronRefusal(request);
  if (refusal) return refusal;
  if (!(await knownWork()).hasSites) return Response.json({ idle: true });
  const report = await flushBuffer({ db: db(), buffer: eventBuffer(), now: () => new Date() });
  // A failure is reported as one, so the platform's logs show it; the events are still in the buffer.
  return Response.json(report, { status: report.failed > 0 ? 503 : 200 });
}
