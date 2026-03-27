import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";

/**
 * CORS middleware that restricts origins to the deployment URL.
 * Reflects the origin only if it matches BETTER_AUTH_URL; otherwise rejects.
 * This is essential because credentials: true + a wildcard origin is a security hole.
 *
 * The cors() handler is instantiated once per worker instance (not per request)
 * since the allowed origin is read from env inside the origin callback at call time.
 */
const corsHandler = cors({
  origin: (origin, c) => {
    if (!origin) return "";
    try {
      const allowedOrigin = new URL((c.env as Env).BETTER_AUTH_URL).origin;
      return origin === allowedOrigin ? origin : "";
    } catch {
      return "";
    }
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

export const corsMiddleware = createMiddleware<{ Bindings: Env }>((c, next) =>
  corsHandler(c, next)
);
