"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSite, deleteSite, NO_SECRET, rotateSiteKey, updateSite } from "@/application/sites";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { sitesChanged } from "@/infrastructure/scheduling/scheduled-work";

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function createSiteAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const secret = env().TRAILIC_SECRET;
  if (!secret) return { ok: false, error: NO_SECRET };
  const made = await createSite(db(), secret, seat.workspaceId, seat.userId, { name: text(form, "name"), domains: text(form, "domains") });
  if (!made.ok) return made;
  sitesChanged();
  redirect(`/sites/${made.id}`);
}

export async function updateSiteAction(siteId: string, _previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const updated = await updateSite(db(), seat.workspaceId, seat.userId, siteId, { name: text(form, "name"), domains: text(form, "domains"), retentionDays: text(form, "retentionDays") });
  if (updated.ok) sitesChanged();
  revalidatePath(`/sites/${siteId}`);
  return updated;
}

export async function rotateKeyAction(siteId: string): Promise<void> {
  const seat = await currentSeat();
  const secret = env().TRAILIC_SECRET;
  if (!secret) return;
  await rotateSiteKey(db(), secret, seat.workspaceId, seat.userId, siteId);
  sitesChanged();
  revalidatePath(`/sites/${siteId}`);
}

export async function deleteSiteAction(siteId: string): Promise<void> {
  const seat = await currentSeat();
  await deleteSite(db(), seat.workspaceId, seat.userId, siteId);
  sitesChanged();
  redirect("/sites");
}
