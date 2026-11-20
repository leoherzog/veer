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

/** The user's role on the team, or a 404 "Team not found" when they are not a member. */
export async function requireTeamMember(
  db: Database,
  teamId: string,
  userId: string,
): Promise<Pick<typeof teamMembers.$inferSelect, "role">> {
  const member = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!member) throw notFound("Team not found");
  return member;
}
