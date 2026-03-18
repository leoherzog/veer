import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./types";
import { corsMiddleware } from "./middleware/cors";
import { requireAuth } from "./middleware/auth";
import authRoutes from "./routes/api/auth";
import linkRoutes, { checkPassword } from "./routes/api/links";
import statsRoutes from "./routes/api/stats";
import { handleRedirect, handleRedirectPost } from "./routes/redirect";

const app = new Hono<AppEnv>();

// Global error handler: consistent JSON errors, no internal detail leaks
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(JSON.stringify({
    message: "Unhandled error",
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    path: c.req.path,
    method: c.req.method,
  }));
  return c.json({ error: "Internal server error" }, 500);
});

// Security headers on all responses
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// CORS for API routes
app.use("/api/*", corsMiddleware);

// Auth routes (no auth middleware - handles its own)
app.route("/api/auth", authRoutes);

// Public API endpoint: password check (no auth required)
app.post("/api/links/:id/check-password", checkPassword);

// Auth middleware for protected API routes (excludes /api/auth/*)
app.use("/api/me", requireAuth);
app.use("/api/links", requireAuth);
app.use("/api/links/*", requireAuth);
app.use("/api/stats/*", requireAuth);

// Current user profile
app.get("/api/me", async (c) => {
  return c.json({ data: c.var.user });
});

// Protected API routes
app.route("/api/links", linkRoutes);
app.route("/api/stats", statsRoutes);

// Redirect engine (must come after /api/*), falls through to SPA on miss
app.get("/:slug", handleRedirect);
app.post("/:slug", handleRedirectPost);

// SPA fallback - serve static asset if it exists, otherwise index.html
app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  // Not a real static file — serve the SPA shell
  const url = new URL(c.req.url);
  url.pathname = "/";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

export default app;
