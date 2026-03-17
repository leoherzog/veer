import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import type { Env } from "../bindings";

/**
 * CORS middleware that restricts origins to the deployment URL.
 * Reflects the origin only if it matches BETTER_AUTH_URL; otherwise rejects.
 * This is essential because credentials: true + a wildcard origin is a security hole.
 */
export const corsMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const allowedOrigin = c.env.BETTER_AUTH_URL;
  const handler = cors({
    origin: (origin) => {
      if (!origin) return "";
      return origin === allowedOrigin ? origin : "";
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
  return handler(c, next);
});
