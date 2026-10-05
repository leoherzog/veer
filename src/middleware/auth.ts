import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { getAuth } from "../auth";
import { getDb } from "../db";
import { apiKeys, user as userTable } from "../db/schema";
import { hashApiKey } from "../lib/crypto";
import { isDemoMode } from "../lib/branding";
import { DEMO_USER } from "../lib/demo";
import type { AppEnv, AuthUser } from "../types";

/** Build `c.var.user` from a user row, deriving `isAdmin` from ADMIN_EMAILS. */
function toAuthUser(env: Env, u: { id: string; name: string; email: string; image?: string | null }): AuthUser {
  const adminEmails = env.ADMIN_EMAILS?.split(",").map((e) => e.trim().toLowerCase()) ?? [];
  // Pick fields explicitly: the Better Auth user carries columns (emailVerified,
  // createdAt, …) that must not leak through `c.var.user` into API responses.
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image ?? null,
    isAdmin: adminEmails.includes(u.email.toLowerCase()),
  };
}

/** The session's user, the synthetic demo user in demo mode, or null. */
async function sessionUser(env: Env, headers: Headers): Promise<AuthUser | null> {
  if (isDemoMode(env)) return DEMO_USER;
  const session = await getAuth(env).api.getSession({ headers });
  return session?.user ? toAuthUser(env, session.user) : null;
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await sessionUser(c.env, c.req.raw.headers);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user?.isAdmin) return c.json({ error: "Forbidden" }, 403);
  await next();
});

export const requireAuthOrApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (isDemoMode(c.env) || !authHeader?.startsWith("Bearer ")) return requireAuth(c, next);

  const key = authHeader.slice(7);
  if (!key) return c.json({ error: "Unauthorized" }, 401);
  const keyHash = await hashApiKey(key, c.env.BETTER_AUTH_SECRET);
  const db = getDb(c.env.DB);

  const [row] = await db.select({
    keyId: apiKeys.id,
    keyExpiresAt: apiKeys.expiresAt,
    user: { id: userTable.id, name: userTable.name, email: userTable.email, image: userTable.image },
  }).from(apiKeys)
    .innerJoin(userTable, eq(apiKeys.userId, userTable.id))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (!row) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (row.keyExpiresAt && row.keyExpiresAt < new Date()) {
    return c.json({ error: "API key expired" }, 401);
  }

  c.set("user", toAuthUser(c.env, row.user));

  c.executionCtx.waitUntil(
    db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId)),
  );

  return next();
});
