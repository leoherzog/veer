import { Hono } from "hono";
import { eq, sql, or, desc, getTableName } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { getDb } from "../../db";
import { user as userTable, teams, teamMembers, links } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody, parsePagination, stripPassword } from "../../lib/request";
import type { AppEnv } from "../../types";

const adminRoutes = new Hono<AppEnv>();

/**
 * Table-qualified reference to a column, for use inside a raw correlated subquery.
 * Drizzle renders a bare `"id"` when the outer select has a single table, which the
 * subquery's own tables then shadow.
 */
function qualify(column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

// GET /users - List all users (paginated, searchable)
adminRoutes.get("/users", async (c) => {
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePagination(c);
  const q = c.req.query("q")?.trim();

  // `%` and `_` are escaped, so the LIKE needs a matching ESCAPE clause or a
  // query containing either character matches nothing.
  const pattern = q ? `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%` : "";
  const where = q
    ? or(
        sql`${userTable.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${userTable.email} LIKE ${pattern} ESCAPE '\\'`
      )
    : undefined;

  const [items, countResult] = await Promise.all([
    db
      .select({
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
        maxLinks: userTable.maxLinks,
        createdAt: userTable.createdAt,
        updatedAt: userTable.updatedAt,
        teamCount: sql<number>`(SELECT count(*) FROM team_members WHERE team_members.userId = ${qualify(userTable.id)})`,
        linkCount: sql<number>`(SELECT count(*) FROM links WHERE links.userId = ${qualify(userTable.id)})`,
      })
      .from(userTable)
      .where(where)
      .orderBy(desc(userTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(userTable).where(where),
  ]);

  return c.json({
    data: items,
    pagination: { page, limit, total: countResult[0]?.count ?? 0 },
  });
});

// GET /users/:id - Single user detail
adminRoutes.get("/users/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const u = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      image: userTable.image,
      maxLinks: userTable.maxLinks,
      createdAt: userTable.createdAt,
      updatedAt: userTable.updatedAt,
    })
    .from(userTable)
    .where(eq(userTable.id, id))
    .get();
  if (!u) throw notFound("User not found");

  const [userTeams, linkCountResult] = await Promise.all([
    db
      .select({
        id: teams.id,
        name: teams.name,
        slug: teams.slug,
        role: teamMembers.role,
        joinedAt: teamMembers.joinedAt,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, id)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(links)
      .where(eq(links.userId, id)),
  ]);

  return c.json({
    data: {
      ...u,
      linkCount: linkCountResult[0]?.count ?? 0,
      teams: userTeams,
    },
  });
});

// PATCH /users/:id - Update user fields (maxLinks)
adminRoutes.patch("/users/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const body = await parseJsonBody<{ maxLinks?: number | null }>(c);

  if (body.maxLinks === undefined) {
    const exists = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, id)).get();
    if (!exists) throw notFound("User not found");
    return c.json({ success: true });
  }

  const updates: Partial<typeof userTable.$inferInsert> = { updatedAt: new Date() };

  // null means unlimited; anything below 1 is rejected.
  if (body.maxLinks === null) {
    updates.maxLinks = null;
  } else {
    const ml = Math.floor(Number(body.maxLinks));
    if (!Number.isFinite(ml) || ml < 1) throw badRequest("maxLinks must be at least 1, or null for unlimited");
    updates.maxLinks = ml;
  }

  const exists = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, id)).get();
  if (!exists) throw notFound("User not found");

  await db.update(userTable).set(updates).where(eq(userTable.id, id));

  const updated = await db.select({
    id: userTable.id,
    name: userTable.name,
    email: userTable.email,
    image: userTable.image,
    maxLinks: userTable.maxLinks,
    updatedAt: userTable.updatedAt,
  }).from(userTable).where(eq(userTable.id, id)).get();

  return c.json({ data: updated });
});

// POST /impersonate/:userId - Start impersonation (client-side only)
// DESIGN NOTE: Impersonation is deliberately client-side only. The admin's real session
// remains active and all API calls execute as the admin. The frontend uses sessionStorage
// to show a visual banner indicating the admin is "viewing as" another user. For actual
// data inspection, use the admin team/user detail endpoints. Server-side session switching
// was considered but rejected to minimize security surface in a self-hosted tool.
adminRoutes.post("/impersonate/:userId", async (c) => {
  const db = getDb(c.env.DB);
  const adminUser = c.var.user!;
  const targetId = c.req.param("userId");

  const target = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      image: userTable.image,
    })
    .from(userTable)
    .where(eq(userTable.id, targetId))
    .get();
  if (!target) throw notFound("User not found");

  console.log(JSON.stringify({
    event: "admin_impersonate",
    adminId: adminUser.id,
    adminEmail: adminUser.email,
    targetId: target.id,
    targetEmail: target.email,
    timestamp: new Date().toISOString(),
  }));

  return c.json({
    user: target,
    impersonating: true,
    adminUserId: adminUser.id,
  });
});

// POST /stop-impersonate - Stop impersonation (client-side only)
adminRoutes.post("/stop-impersonate", async (c) => {
  // Use the actual authenticated admin from the session, not a client-supplied ID
  const admin = c.var.user!;

  return c.json({
    user: { id: admin.id, name: admin.name, email: admin.email, image: admin.image },
    impersonating: false,
  });
});

// GET /teams - List all teams (paginated)
adminRoutes.get("/teams", async (c) => {
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePagination(c);

  const [items, countResult] = await Promise.all([
    db
      .select({
        id: teams.id,
        name: teams.name,
        slug: teams.slug,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        memberCount: sql<number>`(SELECT count(*) FROM team_members WHERE team_members.teamId = ${qualify(teams.id)})`,
        linkCount: sql<number>`(SELECT count(*) FROM links WHERE links.teamId = ${qualify(teams.id)})`,
      })
      .from(teams)
      .orderBy(desc(teams.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(teams),
  ]);

  return c.json({
    data: items,
    pagination: { page, limit, total: countResult[0]?.count ?? 0 },
  });
});

// GET /teams/:id - Admin team detail
adminRoutes.get("/teams/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const team = await db.select().from(teams).where(eq(teams.id, id)).get();
  if (!team) throw notFound("Team not found");

  const members = await db.select({
    userId: teamMembers.userId,
    role: teamMembers.role,
    joinedAt: teamMembers.joinedAt,
    name: userTable.name,
    email: userTable.email,
    image: userTable.image,
  }).from(teamMembers)
    .innerJoin(userTable, eq(teamMembers.userId, userTable.id))
    .where(eq(teamMembers.teamId, id));

  const [linkCountResult] = await db.select({ count: sql<number>`count(*)` })
    .from(links).where(eq(links.teamId, id));

  return c.json({
    data: {
      ...team,
      members,
      linkCount: linkCountResult?.count ?? 0,
    },
  });
});

// GET /teams/:id/links - Admin team links (paginated)
adminRoutes.get("/teams/:id/links", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const { page, limit, offset } = parsePagination(c);

  const team = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, id)).get();
  if (!team) throw notFound("Team not found");

  const [items, countResult] = await Promise.all([
    db.select().from(links).where(eq(links.teamId, id)).orderBy(desc(links.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(links).where(eq(links.teamId, id)),
  ]);

  return c.json({
    data: items.map(l => stripPassword(l)),
    pagination: { page, limit, total: countResult[0]?.count ?? 0 },
  });
});

// DELETE /teams/:id - Delete any team (admin override)
adminRoutes.delete("/teams/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const team = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, id)).get();
  if (!team) throw notFound("Team not found");

  // Links get teamId = NULL via FK ON DELETE SET NULL; KV cache stays valid (see teams.ts delete).
  await db.delete(teams).where(eq(teams.id, id));

  return c.json({ success: true });
});

export default adminRoutes;
