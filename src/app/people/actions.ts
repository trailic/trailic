"use server";

import { redirect } from "next/navigation";
import { erasePerson } from "@/application/people";
import { currentSeat } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

/** Only here, for someone at the screen: no assistant tool erases anyone. */
export async function erasePersonAction(siteId: string, userId: string): Promise<void> {
  const seat = await currentSeat();
  await erasePerson(db(), seat.workspaceId, seat.userId, siteId, userId, new Date());
  redirect(`/people?site=${siteId}`);
}
