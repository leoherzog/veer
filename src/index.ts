import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./types";
import { corsMiddleware } from "./middleware/cors";
import { requireAuth, requireAdmin, requireAuthOrApiKey } from "./middleware/auth";
import { rateLimitApiKey } from "./middleware/rate-limit";
import authRoutes from "./routes/api/auth";
import linkRoutes, { checkPassword } from "./routes/api/links";
import statsRoutes from "./routes/api/stats";
import campaignRoutes from "./routes/api/campaigns";
import domainRoutes from "./routes/api/domains";
import keyRoutes from "./routes/api/keys";
import bulkRoutes from "./routes/api/bulk";
import reportRoutes, { publicReportRoute } from "./routes/api/reports";
import { handleRedirect, handleRedirectPost, handleCustomDomainRoot } from "./routes/redirect";

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
app.use("/api/me/*", requireAuth);
app.use("/api/links", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/links/*", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/stats/*", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/campaigns", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/campaigns/*", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/domains", requireAuth);
app.use("/api/domains/*", requireAuth);
app.use("/api/keys", requireAuth);
app.use("/api/keys/*", requireAuth);
app.use("/api/bulk", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/bulk/*", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/reports", requireAuthOrApiKey, rateLimitApiKey);
app.use("/api/reports/*", requireAuthOrApiKey, rateLimitApiKey);

// Admin-only domain management routes (sync, individual config, access)
app.post("/api/domains/sync", requireAdmin);
app.get("/api/domains/:hostname", requireAdmin);
app.put("/api/domains/:hostname", requireAdmin);
app.get("/api/domains/:hostname/access", requireAdmin);
app.put("/api/domains/:hostname/access", requireAdmin);

// Current user profile
app.get("/api/me", async (c) => {
  return c.json({ data: c.var.user });
});

// Protected API routes
app.route("/api/links", linkRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/campaigns", campaignRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/keys", keyRoutes);
app.route("/api/bulk", bulkRoutes);
app.route("/api/reports", reportRoutes);

// Public report viewer API (no auth, IP rate limited)
app.get("/api/public-report/:token", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const windowEpoch = Math.floor(Date.now() / 1000 / 60);
  const rlKey = `rl:pub:${ip}:${windowEpoch}`;
  const stored = await c.env.KV.get(rlKey);
  const count = stored ? parseInt(stored, 10) : 0;
  if (count >= 30) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  c.executionCtx.waitUntil(
    c.env.KV.put(rlKey, String(count + 1), stored === null ? { expirationTtl: 120 } : {})
  );
  await next();
}, publicReportRoute);

// Custom domain root redirect (before /:slug to handle bare domain visits)
app.get("/", handleCustomDomainRoot);

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
