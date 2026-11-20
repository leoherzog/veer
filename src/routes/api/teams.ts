import { Hono } from "hono";
import { eq, and, gt, lt } from "drizzle-orm";
import { getDb } from "../../db";
import type { Database } from "../../db";
import { teams, teamMembers, teamInvites, links, user as userTable } from "../../db/schema";
import { badRequest, notFound, forbidden, conflict } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { memberWithUser, requireTeamMember } from "../../lib/team";
import { parseName } from "../../lib/validators";
import type { AuthedEnv } from "../../types";

async function requireTeamAdmin(db: Database, teamId: string, userId: string): Promise<void> {
  const member = await requireTeamMember(db, teamId, userId);
  if (member.role !== "admin") throw forbidden("Admin access required");
}

async function requireNotLastAdmin(db: Database, teamId: string, message = "Cannot remove or demote the last admin"): Promise<void> {
  const adminCount = await db.$count(teamMembers, and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")));
  if (adminCount <= 1) {
    throw badRequest(message);
  }
}

/** The member row joined with the member's profile, or a 404 when the user is not on the team. */
async function requireMemberWithUser(db: Database, teamId: string, userId: string) {
  const member = await db.select(memberWithUser)
    .from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  if (!member) throw notFound("Member not found");
  return member;
}

const teamRoutes = new Hono<AuthedEnv>();

teamRoutes.post("/", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{ name: string }>(c);
  const name = parseName(body.name);

  const id = crypto.randomUUID();
  const now = new Date();

  await db.batch([
    db.insert(teams).values({ id, name, createdAt: now, updatedAt: now }),
    db.insert(teamMembers).values({ teamId: id, userId: user.id, role: "admin", joinedAt: now }),
  ]);

  return c.json({ data: { id, name, createdAt: now, updatedAt: now } }, 201);
});

teamRoutes.get("/", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);

  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      createdAt: teams.createdAt,
      updatedAt: teams.updatedAt,
      role: teamMembers.role,
      memberCount: db.$count(teamMembers, eq(teamMembers.teamId, teams.id)),
      linkCount: db.$count(links, eq(links.teamId, teams.id)),
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, user.id))
    .orderBy(teams.name);

  return c.json({ data: rows });
});

teamRoutes.post("/accept-invite", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{ token: string }>(c);

  if (!body.token || typeof body.token !== "string") {
    throw badRequest("token is required");
  }

  const invite = await db.select().from(teamInvites).where(eq(teamInvites.token, body.token)).get();
  if (!invite) throw notFound("Invite not found");

  // Verify the accepting user's email matches the invite
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    throw forbidden("This invite was sent to a different email address");
  }

  if (invite.expiresAt < new Date()) {
    await db.delete(teamInvites).where(eq(teamInvites.id, invite.id));
    throw badRequest("Invite has expired");
  }

  // The insert is the membership check, so a concurrent accept cannot add the user
  // twice. The invite is consumed either way.
  const [joined, , [team]] = await db.batch([
    db.insert(teamMembers)
      .values({ teamId: invite.teamId, userId: user.id, role: invite.role, joinedAt: new Date() })
      .onConflictDoNothing()
      .returning(),
    db.delete(teamInvites).where(eq(teamInvites.id, invite.id)),
    db.select().from(teams).where(eq(teams.id, invite.teamId)),
  ]);
  if (joined.length === 0) throw conflict("Already a member of this team");

  return c.json({ data: { teamId: invite.teamId, team } });
});

teamRoutes.get("/:id", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const [[team], members] = await db.batch([
    db.select().from(teams).where(eq(teams.id, id)),
    db.select(memberWithUser)
      .from(teamMembers)
      .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
      .where(eq(teamMembers.teamId, id)),
  ]);
  // A non-member gets the same 404 as a missing team.
  if (!team || !members.some(m => m.userId === user.id)) throw notFound("Team not found");

  return c.json({ data: { ...team, members } });
});

teamRoutes.put("/:id", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  const body = await parseJsonBody<{ name?: string }>(c);
  const name = parseName(body.name);

  const updated = await db.update(teams).set({ name, updatedAt: new Date() }).where(eq(teams.id, id)).returning().get();
  return c.json({ data: updated });
});

teamRoutes.delete("/:id", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  // Links fall back to teamId NULL via ON DELETE SET NULL; the KV cache holds no team data.
  await db.delete(teams).where(eq(teams.id, id));

  return c.json({ success: true });
});

teamRoutes.post("/:id/invite", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  const body = await parseJsonBody<{ email: string; role?: string }>(c);

  if (!body.email || typeof body.email !== "string" || !body.email.includes("@")) {
    throw badRequest("Valid email is required");
  }
  const email = body.email.trim().toLowerCase();
  const role = body.role === "admin" ? "admin" : "member";

  const existingMember = await db.select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(and(eq(teamMembers.teamId, id), eq(userTable.email, email)))
    .get();
  if (existingMember) throw conflict("This user is already a member of the team");

  const now = new Date();

  // An expired invite still occupies the unique (teamId, email) slot while being hidden
  // from the invite list, so it goes first. The insert is then the duplicate check.
  const [, [invite]] = await db.batch([
    db.delete(teamInvites).where(and(
      eq(teamInvites.teamId, id),
      eq(teamInvites.email, email),
      lt(teamInvites.expiresAt, now),
    )),
    db.insert(teamInvites).values({
      id: crypto.randomUUID(),
      teamId: id,
      email,
      role,
      token: crypto.randomUUID(),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: now,
    }).onConflictDoNothing({ target: [teamInvites.teamId, teamInvites.email] }).returning(),
  ]);
  if (!invite) throw conflict("An invite for this email already exists");

  return c.json({ data: invite }, 201);
});

teamRoutes.get("/:id/invites", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  // The token is returned so an admin can re-copy the invite link; the route is admin-only.
  const invites = await db.select({
    id: teamInvites.id,
    email: teamInvites.email,
    role: teamInvites.role,
    token: teamInvites.token,
    expiresAt: teamInvites.expiresAt,
    createdAt: teamInvites.createdAt,
  }).from(teamInvites).where(and(eq(teamInvites.teamId, id), gt(teamInvites.expiresAt, new Date())));

  return c.json({ data: invites });
});

teamRoutes.delete("/:id/invites/:inviteId", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const inviteId = c.req.param("inviteId");

  await requireTeamAdmin(db, id, user.id);

  const result = await db.delete(teamInvites)
    .where(and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, id)));
  if (!result.meta?.changes) throw notFound("Invite not found");

  return c.json({ success: true });
});

teamRoutes.post("/:id/leave", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const member = await requireTeamMember(db, id, user.id);

  if (member.role === "admin") {
    await requireNotLastAdmin(db, id, "You are the last admin. Promote another member or delete the team.");
  }

  await db.delete(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)));

  return c.json({ success: true });
});

teamRoutes.delete("/:id/members/:userId", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  await requireTeamAdmin(db, id, user.id);

  const target = await requireMemberWithUser(db, id, targetUserId);

  if (target.role === "admin") {
    await requireNotLastAdmin(db, id);
  }

  // Removing the member also cancels any outstanding invite for their email.
  await db.batch([
    db.delete(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId))),
    db.delete(teamInvites).where(and(eq(teamInvites.teamId, id), eq(teamInvites.email, target.email.toLowerCase()))),
  ]);

  return c.json({ success: true });
});

teamRoutes.patch("/:id/members/:userId", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  await requireTeamAdmin(db, id, user.id);

  const body = await parseJsonBody<{ role?: unknown }>(c);
  const role = body.role;
  if (role !== "admin" && role !== "member") {
    throw badRequest("role must be 'admin' or 'member'");
  }

  const target = await requireMemberWithUser(db, id, targetUserId);

  if (target.role === "admin" && role === "member") {
    await requireNotLastAdmin(db, id);
  }

  await db.update(teamMembers)
    .set({ role })
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)));

  return c.json({ data: { ...target, role } });
});

export default teamRoutes;
