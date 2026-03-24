import { createMiddleware } from "hono/factory";
import { getAuth } from "../auth";
import type { AppEnv, AuthUser } from "../types";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const auth = getAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const adminEmails = c.env.ADMIN_EMAILS?.split(",").map(e => e.trim().toLowerCase()) ?? [];
  const isAdmin = adminEmails.includes(session.user.email.toLowerCase());

  c.set("user", { ...session.user, isAdmin } as AuthUser);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user?.isAdmin) return c.json({ error: "Forbidden" }, 403);
  await next();
});
