"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createFunnel, deleteFunnel } from "@/application/funnels";
import { siteIn } from "@/application/sites";
import { stepsFromLines } from "@/domain/funnels";
import type { Tried } from "@/domain/tried";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

export async function createFunnelAction(_previous: Tried | null, form: FormData): Promise<Tried> {
  const seat = await currentSeat();
  const site = await siteIn(db(), seat.workspaceId, String(form.get("site") ?? ""));
  if (!site) return { ok: false, error: "Choose a site first." };
  const made = await createFunnel(db(), seat.workspaceId, { siteId: site.id, name: String(form.get("name") ?? ""), steps: stepsFromLines(String(form.get("steps") ?? "")), windowHours: Number(form.get("windowHours")) });
  if (!made.ok) return made;
  revalidatePath("/funnels");
  redirect(`/funnels/${made.id}`);
}

export async function deleteFunnelAction(id: string): Promise<void> {
  const seat = await currentSeat();
  await deleteFunnel(db(), seat.workspaceId, seat.userId, id);
  redirect("/funnels");
}
