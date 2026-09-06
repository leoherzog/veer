/** Link visibility check shared by every route that reads or mutates a link by id. */
import { eq, and, or, sql, type SQL } from "drizzle-orm";
import { teamMembers, links } from "../db/schema";
import type { Database } from "../db";

/** True when the user owns the link or is a member of the link's team. */
export async function canAccessLink(
  db: Database,
  link: { userId: string; teamId: string | null },
  userId: string,
): Promise<boolean> {
  if (link.userId === userId) return true;
  if (!link.teamId) return false;
  const member = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, link.teamId), eq(teamMembers.userId, userId)))
    .get();
  return !!member;
}

/**
 * SQL form of canAccessLink, for queries that filter many links at once.
 * Matches links the user owns plus links of teams they currently belong to.
 */
export function accessibleLinks(userId: string): SQL {
  return or(
    eq(links.userId, userId),
    sql`${links.teamId} IN (SELECT ${teamMembers.teamId} FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId})`,
  )!;
}
