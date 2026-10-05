/** Link visibility check shared by every route that reads or mutates a link by id. */
import { eq, and, or, sql, type SQL } from "drizzle-orm";
import { teamMembers, links } from "../db/schema";
import { notFound } from "./errors";
import type { Database } from "../db";

/** Matches links the user owns plus links of teams they currently belong to. */
export function accessibleLinks(userId: string): SQL {
  return or(
    eq(links.userId, userId),
    sql`${links.teamId} IN (SELECT ${teamMembers.teamId} FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId})`,
  )!;
}

/** Load a link the user can access, or throw 404 whether it is missing or denied. */
export async function requireAccessibleLink(db: Database, linkId: string, userId: string): Promise<typeof links.$inferSelect> {
  const link = await db.select().from(links).where(and(eq(links.id, linkId), accessibleLinks(userId))).get();
  if (!link) throw notFound("Link not found");
  return link;
}
