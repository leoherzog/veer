import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { getAuth } from "../auth";
import { getDb } from "../db";
import { apiKeys, user as userTable } from "../db/schema";
import { hashApiKey } from "../lib/crypto";
import { isDemoMode } from "../lib/branding";
import { DEMO_USER } from "../lib/demo";
import type { AppEnv, AuthUser } from "../types";

function isAdminUser(env: AppEnv["Bindings"], email: string): boolean {
  const adminEmails = env.ADMIN_EMAILS?.split(",").map((e: string) => e.trim().toLowerCase()) ?? [];
  return adminEmails.includes(email.toLowerCase());
}

async function checkSession(c: { env: AppEnv["Bindings"]; req: { raw: Request } }): Promise<AuthUser | null> {
  const auth = getAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return null;
  const isAdmin = isAdminUser(c.env, session.user.email);
  return { ...session.user, isAdmin };
}

/** Inject the synthetic demo user when DEMO_MODE=true. Returns true if demo bypass fired. */
async function tryDemoBypass(c: { env: AppEnv["Bindings"]; set: (k: "user", v: AuthUser) => void }): Promise<boolean> {
  if (!isDemoMode(c.env)) return false;
  c.set("user", DEMO_USER);
  return true;
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (await tryDemoBypass(c)) return next();
  const user = await checkSession(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user?.isAdmin) return c.json({ error: "Forbidden" }, 403);
  await next();
});

export const requireAuthOrApiKey = createMiddleware<AppEnv>(async (c, next) => {
  if (await tryDemoBypass(c)) return next();
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const key = authHeader.slice(7);
    if (!key) return c.json({ error: "Unauthorized" }, 401);
    const keyHash = await hashApiKey(key, c.env.BETTER_AUTH_SECRET);
    const db = getDb(c.env.DB);

    const [row] = await db.select({
      keyId: apiKeys.id,
      keyExpiresAt: apiKeys.expiresAt,
      userId: userTable.id,
      userName: userTable.name,
      userEmail: userTable.email,
      userImage: userTable.image,
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

    const isAdmin = isAdminUser(c.env, row.userEmail);

    c.set("user", {
      id: row.userId,
      name: row.userName,
      email: row.userEmail,
      image: row.userImage ?? null,
      isAdmin,
    });

    c.executionCtx.waitUntil(
      db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId)),
    );

    return await next();
  }

  // Fall through to session auth
  const user = await checkSession(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
});
