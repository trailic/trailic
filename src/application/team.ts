import { and, eq } from "drizzle-orm";
import { refusalToChangeRole, refusalToRemove, type Role } from "@/domain/team";
import type { Tried } from "@/domain/tried";
import { user } from "@/infrastructure/db/schema/auth";
import type { Database } from "@/infrastructure/db/client";
import { member } from "@/infrastructure/db/schema/tenancy";

/** A workspace's members, the first to join first. Memberships are written and read on the trusted path: the app role can't write them. */
export async function teamOf(db: Database, workspaceId: string) {
  return db
    .select({ userId: member.userId, role: member.role, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.workspaceId, workspaceId))
    .orderBy(member.createdAt);
}

/** Someone's role in a workspace, read now: undefined when they aren't in it. */
export async function roleIn(db: Database, workspaceId: string, userId: string): Promise<Role | undefined> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.workspaceId, workspaceId), eq(member.userId, userId)));
  return row?.role;
}

/** The team, locked until the change is made: two owners demoting each other at once must not leave a workspace with none. */
const lockedTeam = (tx: Database, workspaceId: string) => tx.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.workspaceId, workspaceId)).orderBy(member.createdAt).for("update");

/** Takes someone out of a workspace, themselves included when they leave. Their access ends at once: every path re-reads membership. */
export async function removeMember(db: Database, workspaceId: string, actorId: string, targetId: string): Promise<Tried> {
  return db.transaction(async (tx) => {
    const team = await lockedTeam(tx, workspaceId);
    const refused = refusalToRemove(team, actorId, targetId);
    if (refused) return { ok: false, error: refused };
    await tx.delete(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, targetId)));
    return { ok: true, said: actorId === targetId ? "You left this workspace." : "This person no longer has access to this workspace." };
  });
}

export async function changeRole(db: Database, workspaceId: string, actorId: string, targetId: string, role: Role): Promise<Tried> {
  return db.transaction(async (tx) => {
    const refused = refusalToChangeRole(await lockedTeam(tx, workspaceId), actorId, targetId, role);
    if (refused) return { ok: false, error: refused };
    await tx
      .update(member)
      .set({ role })
      .where(and(eq(member.workspaceId, workspaceId), eq(member.userId, targetId)));
    return { ok: true, said: "Saved." };
  });
}
