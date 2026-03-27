import { eq, and } from "drizzle-orm";
import { teamMembers } from "../db/schema";
import { notFound } from "./errors";
import type { Database } from "../db";

export async function requireTeamMember(db: Database, teamId: string, userId: string): Promise<{ role: string }> {
  const member = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!member) throw notFound("Team not found");
  return member;
}
