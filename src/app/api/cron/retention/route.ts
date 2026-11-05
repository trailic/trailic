import { applyRetention } from "@/application/retention";
import { databaseAnswers } from "@/infrastructure/db/answers";
import { db } from "@/infrastructure/db/client";
import { cronRefusal, knownWork } from "../scheduled-work";

/** Removes raw events past each site's retention, daily. With no site it answers without touching the database. */
export async function GET(request: Request) {
  const refusal = cronRefusal(request);
  if (refusal) return refusal;
  if (!(await knownWork()).hasSites) return Response.json({ idle: true });
  // It runs again tomorrow: a frozen database shouldn't keep this open until the platform kills it.
  if (!(await databaseAnswers(db()))) return Response.json({ failed: "The database isn’t answering." }, { status: 503 });
  return Response.json(await applyRetention(db(), new Date()));
}
