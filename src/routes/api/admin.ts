import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../../db";
import { user as userTable, teams, teamMembers, links } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody, parsePagination, searchFilter } from "../../lib/request";
import type { AppEnv } from "../../types";

const adminRoutes = new Hono<AppEnv>();

// GET /users - List all users (paginated, searchable)
adminRoutes.get("/users", async (c) => {
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePagination(c);
  const where = searchFilter(c.req.query("q"), userTable.name, userTable.email);

  const [items, total] = await Promise.all([
    db
      .select({
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
        maxLinks: userTable.maxLinks,
        createdAt: userTable.createdAt,
        updatedAt: userTable.updatedAt,
        linkCount: db.$count(links, eq(links.userId, userTable.id)),
      })
      .from(userTable)
      .where(where)
      .orderBy(desc(userTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.$count(userTable, where),
  ]);

  return c.json({
    data: items,
    pagination: { page, limit, total },
  });
});

// PATCH /users/:id - Update user fields (maxLinks)
adminRoutes.patch("/users/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const body = await parseJsonBody<{ maxLinks?: number | null }>(c);

  const columns = {
    id: userTable.id,
    name: userTable.name,
    email: userTable.email,
    image: userTable.image,
    maxLinks: userTable.maxLinks,
    updatedAt: userTable.updatedAt,
  };

  // An absent maxLinks is a no-op that still 404s an unknown user.
  if (body.maxLinks === undefined) {
    const current = await db.select(columns).from(userTable).where(eq(userTable.id, id)).get();
    if (!current) throw notFound("User not found");
    return c.json({ data: current });
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

  const updated = await db.update(userTable).set(updates).where(eq(userTable.id, id)).returning(columns).get();
  if (!updated) throw notFound("User not found");

  return c.json({ data: updated });
});

// POST /impersonate/:userId - Start impersonation (client-side only)
// DESIGN NOTE: Impersonation is deliberately client-side only. The admin's real session
// remains active and all API calls execute as the admin. The frontend uses sessionStorage
// to show a visual banner indicating the admin is "viewing as" another user. Server-side
// session switching was considered but rejected to minimize security surface in a
// self-hosted tool.
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

  const [items, total] = await Promise.all([
    db
      .select({
        id: teams.id,
        name: teams.name,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        memberCount: db.$count(teamMembers, eq(teamMembers.teamId, teams.id)),
        linkCount: db.$count(links, eq(links.teamId, teams.id)),
      })
      .from(teams)
      .orderBy(desc(teams.createdAt))
      .limit(limit)
      .offset(offset),
    db.$count(teams),
  ]);

  return c.json({
    data: items,
    pagination: { page, limit, total },
  });
});

// DELETE /teams/:id - Delete any team (admin override)
adminRoutes.delete("/teams/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const team = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, id)).get();
  if (!team) throw notFound("Team not found");

  // Links fall back to teamId NULL via ON DELETE SET NULL; the KV cache holds no team data.
  await db.delete(teams).where(eq(teams.id, id));

  return c.json({ success: true });
});

export default adminRoutes;
