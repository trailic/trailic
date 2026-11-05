import { cacheLife, cacheTag } from "next/cache";
import { whatIsScheduled, type ScheduledWork } from "@/application/scheduled-work";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import { withinTime } from "@/infrastructure/db/answers";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { SITES_TAG } from "@/infrastructure/scheduling/scheduled-work";

const DAY_SECONDS = 86_400;

/**
 * What the jobs have to do, kept outside the database so that asking doesn't wake it. Whatever
 * changes it clears it at once; the daily refresh is only the safety net for a change made by hand.
 */
export async function scheduledWork(): Promise<ScheduledWork> {
  "use cache: remote";
  cacheTag(SITES_TAG);
  cacheLife({ revalidate: DAY_SECONDS, expire: 2 * DAY_SECONDS });
  return whatIsScheduled(db());
}

/** How long a job waits to be told: a cold cache with a frozen database shouldn't keep it open. */
const WAIT_MS = 3_000;

/** What the job has to do, assuming there's work when nobody can say: finding out is the job's next step, and it costs no more. */
export const knownWork = async (): Promise<ScheduledWork> => (await withinTime(scheduledWork(), WAIT_MS).catch(() => null)) ?? { hasSites: true };

/** The refusal for anyone but the platform's scheduler, or null when it's the scheduler. */
export function cronRefusal(request: Request): Response | null {
  // The header first: a build prerenders this route, and has no environment to read.
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const secret = env().CRON_SECRET;
  return secret && sameSecret(given, secret) ? null : new Response(null, { status: 401 });
}
