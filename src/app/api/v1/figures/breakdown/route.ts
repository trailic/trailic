import { accessOfKey, bearerOf } from "@/application/api-keys";
import { breakdownOf, BREAKDOWNS, type Breakdown } from "@/application/figures";
import { isUuid } from "@/application/sites";
import { boundedDays, periodEndingAt } from "@/application/time-range";
import { appServices } from "@/infrastructure/services";

const isBreakdown = (value: string | null): value is Breakdown => (BREAKDOWNS as readonly (string | null)[]).includes(value);

/** One page's or one custom event's figures per day, for a dashboard holding one of a workspace's keys. Shape documented in docs/00-product.md. */
export async function GET(request: Request) {
  // The header first: a build prerenders this route, and has no environment to read for what follows.
  const key = bearerOf(request);
  const services = appServices();
  const access = await accessOfKey(services.db, key, "figures:read");
  if (access.status === "unknown") return Response.json({ error: "Missing or refused API key." }, { status: 401 });
  if (access.status === "forbidden") return Response.json({ error: "This key may not read figures." }, { status: 403 });
  const query = new URL(request.url).searchParams;
  const [siteId, dimension, value] = [query.get("site"), query.get("dimension"), query.get("value")];
  if (!siteId || !isUuid(siteId)) return Response.json({ error: "site is a site’s id." }, { status: 400 });
  if (!isBreakdown(dimension)) return Response.json({ error: `dimension is one of ${BREAKDOWNS.join(", ")}.` }, { status: 400 });
  if (!value) return Response.json({ error: "value is the page’s path or the event’s name." }, { status: 400 });
  const figures = await breakdownOf(services.db, access.workspaceId, { siteId, dimension, value, period: periodEndingAt(services.now(), boundedDays(query.get("days"))) });
  return figures ? Response.json(figures) : Response.json({ error: "No such site in this workspace." }, { status: 404 });
}
