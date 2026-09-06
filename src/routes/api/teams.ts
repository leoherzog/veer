import { Hono } from "hono";
import { eq, sql, and, lt } from "drizzle-orm";
import { getDb } from "../../db";
import type { Database } from "../../db";
import { teams, teamMembers, teamInvites, user as userTable } from "../../db/schema";
import { validateTeamSlug } from "../../services/slug";
import { badRequest, notFound, forbidden, conflict } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { requireTeamMember } from "../../lib/team";
import type { AppEnv } from "../../types";

// --- Helpers ---

/** Clean up teams after a user is deleted — promote next member or dissolve empty teams. */
export async function cleanupOrphanedTeams(db: Database) {
  // Find teams with no admins but still have members
  const orphanedTeams = await db.select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .groupBy(teamMembers.teamId)
    .having(sql`sum(case when ${teamMembers.role} = 'admin' then 1 else 0 end) = 0`);

  // Promote the earliest-joined member per orphaned team in a single batch
  if (orphanedTeams.length > 0) {
    const teamIds = orphanedTeams.map(t => t.teamId);
    await db.run(sql`
      UPDATE ${teamMembers} SET role = 'admin'
      WHERE rowid IN (
        SELECT MIN(rowid) FROM ${teamMembers}
        WHERE ${teamMembers.teamId} IN ${teamIds}
        GROUP BY ${teamMembers.teamId}
      )
    `);
  }

  // Delete teams with zero members
  await db.run(sql`DELETE FROM ${teams} WHERE ${teams.id} NOT IN (SELECT DISTINCT ${teamMembers.teamId} FROM ${teamMembers})`);
}

async function requireTeamAdmin(db: Database, teamId: string, userId: string) {
  const member = await requireTeamMember(db, teamId, userId);
  if (member.role !== "admin") throw forbidden("Admin access required");
  return member;
}

async function requireNotLastAdmin(db: Database, teamId: string, message = "Cannot remove or demote the last admin"): Promise<void> {
  const [adminCount] = await db.select({ count: sql<number>`count(*)` })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "admin")));
  if ((adminCount?.count ?? 0) <= 1) {
    throw badRequest(message);
  }
}


// --- Routes ---

const teamRoutes = new Hono<AppEnv>();

// Create team
teamRoutes.post("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{ name: string; slug: string }>(c);

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    throw badRequest("name is required");
  }
  if (body.name.trim().length > 200) {
    throw badRequest("name must be 200 characters or fewer");
  }

  if (!body.slug || typeof body.slug !== "string") {
    throw badRequest("slug is required");
  }

  const slugCheck = validateTeamSlug(body.slug);
  if (!slugCheck.valid) throw badRequest(slugCheck.error);
  const slug = slugCheck.slug;

  const id = crypto.randomUUID();
  const now = new Date();

  try {
    await db.batch([
      db.insert(teams).values({ id, name: body.name.trim(), slug, createdAt: now, updatedAt: now }),
      db.insert(teamMembers).values({ teamId: id, userId: user.id, role: "admin", joinedAt: now }),
    ]);
  } catch (e: unknown) {
    if (e instanceof Error && (e.message.includes("UNIQUE constraint") || (e.cause instanceof Error && e.cause.message.includes("UNIQUE constraint")))) {
      throw conflict("Team slug already taken");
    }
    throw e;
  }

  return c.json({
    data: {
      id,
      name: body.name.trim(),
      slug,
      createdAt: now,
      updatedAt: now,
    },
  }, 201);
});

// List user's teams
teamRoutes.get("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);

  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      slug: teams.slug,
      createdAt: teams.createdAt,
      updatedAt: teams.updatedAt,
      role: teamMembers.role,
      memberCount: sql<number>`(SELECT count(*) FROM team_members WHERE team_members.teamId = ${teams.id})`,
      linkCount: sql<number>`(SELECT count(*) FROM links WHERE links.teamId = ${teams.id})`,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, user.id))
    .orderBy(teams.name);

  return c.json({ data: rows });
});

// Accept invite (no team ID in path - uses token)
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

  // Check if user is already a member
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

// Get team details
teamRoutes.get("/:id", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamMember(db, id, user.id);

  const team = await db.select().from(teams).where(eq(teams.id, id)).get();
  if (!team) throw notFound("Team not found");

  const [members, inviteCount] = await Promise.all([
    db.select({
      userId: teamMembers.userId,
      role: teamMembers.role,
      joinedAt: teamMembers.joinedAt,
      name: userTable.name,
      email: userTable.email,
      image: userTable.image,
    }).from(teamMembers)
      .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
      .where(eq(teamMembers.teamId, id)),
    db.select({ count: sql<number>`count(*)` })
      .from(teamInvites)
      .where(and(eq(teamInvites.teamId, id), sql`${teamInvites.expiresAt} > ${Math.floor(Date.now() / 1000)}`)),
  ]);

  return c.json({
    data: {
      ...team,
      members,
      inviteCount: inviteCount[0]?.count ?? 0,
    },
  });
});

// Update team name
teamRoutes.put("/:id", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  const body = await parseJsonBody<{ name?: string }>(c);

  if (body.name === undefined || !body.name?.trim()) {
    throw badRequest("name is required");
  }
  if (body.name.trim().length > 200) {
    throw badRequest("name must be 200 characters or fewer");
  }

  await db.update(teams).set({ name: body.name.trim(), updatedAt: new Date() }).where(eq(teams.id, id));

  const updated = await db.select().from(teams).where(eq(teams.id, id)).get();
  return c.json({ data: updated });
});

// Delete team
teamRoutes.delete("/:id", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await requireTeamAdmin(db, id, user.id);

  // NOTE: Links with this teamId will have teamId set to NULL by FK cascade (ON DELETE SET NULL).
  // KV cache entries for those links are not invalidated — they continue redirecting correctly
  // with a stale teamId in the cached metadata. This is acceptable since the redirect URL,
  // active status, and all other fields remain valid.
  await db.delete(teams).where(eq(teams.id, id));

  return c.json({ success: true });
});

// --- Membership routes ---

// Invite by email
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

  // Check for duplicate pending invite
  const existingInvite = await db.select({ id: teamInvites.id })
    .from(teamInvites)
    .where(and(eq(teamInvites.teamId, id), eq(teamInvites.email, email)))
    .get();
  if (existingInvite) throw conflict("An invite for this email already exists");

  // Check if user is already a member of this team
  const existingMember = await db.select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(and(eq(teamMembers.teamId, id), eq(userTable.email, email)))
    .get();
  if (existingMember) throw conflict("This user is already a member of the team");

  const inviteId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

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

// List pending invites
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
  }).from(teamInvites).where(and(eq(teamInvites.teamId, id), sql`${teamInvites.expiresAt} > ${Math.floor(Date.now() / 1000)}`));

  return c.json({ data: invites });
});

// Cancel invite
teamRoutes.delete("/:id/invites/:inviteId", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const inviteId = c.req.param("inviteId");

  await requireTeamAdmin(db, id, user.id);

  const invite = await db.select({ id: teamInvites.id })
    .from(teamInvites)
    .where(and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, id)))
    .get();
  if (!invite) throw notFound("Invite not found");

  await db.delete(teamInvites).where(eq(teamInvites.id, inviteId));

  return c.json({ success: true });
});

// Leave team (self-removal)
teamRoutes.post("/:id/leave", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const member = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)))
    .get();
  if (!member) throw notFound("Team not found");

  // Prevent last admin from leaving
  if (member.role === "admin") {
    await requireNotLastAdmin(db, id, "You are the last admin. Promote another member or delete the team.");
  }

  await db.delete(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)));

  return c.json({ success: true });
});

// Remove member
teamRoutes.delete("/:id/members/:userId", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  await requireTeamAdmin(db, id, user.id);

  // Verify target is actually a member
  const target = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)))
    .get();
  if (!target) throw notFound("Member not found");

  // Prevent removing the last admin
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

// Change member role
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

  // Verify target is actually a member
  const target = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)))
    .get();
  if (!target) throw notFound("Member not found");

  // If demoting from admin, ensure not last admin
  if (target.role === "admin" && body.role === "member") {
    await requireNotLastAdmin(db, id);
  }

  await db.update(teamMembers)
    .set({ role: body.role })
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)));

  const updated = await db.select({
    userId: teamMembers.userId,
    role: teamMembers.role,
    joinedAt: teamMembers.joinedAt,
    name: userTable.name,
    email: userTable.email,
    image: userTable.image,
  }).from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, targetUserId)))
    .get();

  return c.json({ data: updated });
});

export default teamRoutes;
