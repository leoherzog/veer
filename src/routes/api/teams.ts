import { Hono } from "hono";
import { eq, and, gt, lt } from "drizzle-orm";
import { getDb } from "../../db";
import type { Database } from "../../db";
import { teams, teamMembers, teamInvites, links, user as userTable } from "../../db/schema";
import { badRequest, notFound, forbidden, conflict } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { memberWithUser, requireTeamMember } from "../../lib/team";
import { parseName } from "../../lib/validators";
import type { AppEnv } from "../../types";

async function requireTeamAdmin(db: Database, teamId: string, userId: string) {
  const member = await requireTeamMember(db, teamId, userId);
  if (member.role !== "admin") throw forbidden("Admin access required");
  return member;
}

async function requireNotLastAdmin(db: Database, teamId: string, message = "Cannot remove or demote the last admin"): Promise<void> {
  const adminCount = await db.$count(teamMembers, and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")));
  if (adminCount <= 1) {
    throw badRequest(message);
  }
}

const teamRoutes = new Hono<AppEnv>();

teamRoutes.post("/", async (c) => {
  const user = c.var.user!;
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
  const user = c.var.user!;
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
  const user = c.var.user!;
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

  const existingMember = await db.select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, invite.teamId), eq(teamMembers.userId, user.id)))
    .get();
  if (existingMember) {
    await db.delete(teamInvites).where(eq(teamInvites.id, invite.id));
    throw conflict("Already a member of this team");
  }

  // Add member and delete invite atomically
  await db.batch([
    db.insert(teamMembers).values({ teamId: invite.teamId, userId: user.id, role: invite.role, joinedAt: new Date() }),
    db.delete(teamInvites).where(eq(teamInvites.id, invite.id)),
  ]);

  const team = await db.select().from(teams).where(eq(teams.id, invite.teamId)).get();

  return c.json({ data: { teamId: invite.teamId, team } });
});

teamRoutes.get("/:id", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamMember(db, id, user.id);

  const team = await db.select().from(teams).where(eq(teams.id, id)).get();
  if (!team) throw notFound("Team not found");

  const members = await db.select(memberWithUser)
    .from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(eq(teamMembers.teamId, id));

  return c.json({ data: { ...team, members } });
});

teamRoutes.put("/:id", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  const body = await parseJsonBody<{ name?: string }>(c);
  const name = parseName(body.name);

  const updated = await db.update(teams).set({ name, updatedAt: new Date() }).where(eq(teams.id, id)).returning().get();
  return c.json({ data: updated });
});

teamRoutes.delete("/:id", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  // Links fall back to teamId NULL via ON DELETE SET NULL; the KV cache holds no team data.
  await db.delete(teams).where(eq(teams.id, id));

  return c.json({ success: true });
});

teamRoutes.post("/:id/invite", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  const body = await parseJsonBody<{ email: string; role?: string }>(c);

  if (!body.email || typeof body.email !== "string" || !body.email.includes("@")) {
    throw badRequest("Valid email is required");
  }
  const email = body.email.trim().toLowerCase();
  const role = body.role === "admin" ? "admin" : "member";

  // An expired invite still occupies the unique (teamId, email) slot while being hidden
  // from the invite list, so it must go before the duplicate check.
  await db.delete(teamInvites).where(and(
    eq(teamInvites.teamId, id),
    eq(teamInvites.email, email),
    lt(teamInvites.expiresAt, new Date()),
  ));

  const existingInvite = await db.select({ id: teamInvites.id })
    .from(teamInvites)
    .where(and(eq(teamInvites.teamId, id), eq(teamInvites.email, email)))
    .get();
  if (existingInvite) throw conflict("An invite for this email already exists");

  const existingMember = await db.select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(and(eq(teamMembers.teamId, id), eq(userTable.email, email)))
    .get();
  if (existingMember) throw conflict("This user is already a member of the team");

  const inviteId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(teamInvites).values({
    id: inviteId,
    teamId: id,
    email,
    role,
    token,
    expiresAt,
    createdAt: now,
  });

  return c.json({
    data: {
      id: inviteId,
      teamId: id,
      email,
      role,
      token,
      expiresAt,
      createdAt: now,
    },
  }, 201);
});

teamRoutes.get("/:id/invites", async (c) => {
  const user = c.var.user!;
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
  const user = c.var.user!;
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
  const user = c.var.user!;
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
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  await requireTeamAdmin(db, id, user.id);

  const target = await requireTeamMember(db, id, targetUserId, "Member not found");

  if (target.role === "admin") {
    await requireNotLastAdmin(db, id);
  }

  await db.delete(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)));

  // Cancel any outstanding invites for the removed member's email
  const removedUser = await db.select({ email: userTable.email }).from(userTable).where(eq(userTable.id, targetUserId)).get();
  if (removedUser) {
    await db.delete(teamInvites).where(and(eq(teamInvites.teamId, id), eq(teamInvites.email, removedUser.email.toLowerCase())));
  }

  return c.json({ success: true });
});

teamRoutes.patch("/:id/members/:userId", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  await requireTeamAdmin(db, id, user.id);

  const body = await parseJsonBody<{ role: string }>(c);

  if (body.role !== "admin" && body.role !== "member") {
    throw badRequest("role must be 'admin' or 'member'");
  }

  const target = await requireTeamMember(db, id, targetUserId, "Member not found");

  if (target.role === "admin" && body.role === "member") {
    await requireNotLastAdmin(db, id);
  }

  await db.update(teamMembers)
    .set({ role: body.role })
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)));

  const updated = await db.select(memberWithUser)
    .from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)))
    .get();

  return c.json({ data: updated });
});

export default teamRoutes;
