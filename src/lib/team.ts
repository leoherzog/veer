import { eq, and } from "drizzle-orm";
import { teamMembers, user } from "../db/schema";
import { notFound } from "./errors";
import type { Database } from "../db";

/** A member row joined with the member's profile; select it from teamMembers inner-joined to user. */
export const memberWithUser = {
  userId: teamMembers.userId,
  role: teamMembers.role,
  joinedAt: teamMembers.joinedAt,
  name: user.name,
  email: user.email,
  image: user.image,
};

/**
 * The user's role on the team, or a 404 when they are not a member.
 * @param notFoundMessage - The 404 message.
 */
export async function requireTeamMember(
  db: Database,
  teamId: string,
  userId: string,
  notFoundMessage = "Team not found",
): Promise<{ role: string }> {
  const member = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!member) throw notFound(notFoundMessage);
  return member;
}
