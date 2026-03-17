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

  c.set("user", session.user as AuthUser);
  await next();
});
