import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./types";
import { corsMiddleware } from "./middleware/cors";
import { requireAuth, requireAdmin, requireAuthOrApiKey } from "./middleware/auth";
import { rateLimitApiKey, rateLimitSession } from "./middleware/rate-limit";
import authRoutes from "./routes/api/auth";
import linkRoutes, { checkPassword } from "./routes/api/links";
import statsRoutes from "./routes/api/stats";
import campaignRoutes from "./routes/api/campaigns";
import domainRoutes from "./routes/api/domains";
import keyRoutes from "./routes/api/keys";
import bulkRoutes from "./routes/api/bulk";
import reportRoutes, { publicReportRoute } from "./routes/api/reports";
import teamRoutes from "./routes/api/teams";
import adminRoutes from "./routes/api/admin";
import { handleRedirect, handleRedirectPost, handleCustomDomainRoot } from "./routes/redirect";
import { getInstanceName, isDemoMode } from "./lib/branding";
import { DEMO_BLOCKED_MESSAGE } from "./lib/demo";
import { scheduled } from "./scheduled";

export const app = new Hono<AppEnv>();

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
  c.header("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'sha256-6lEELWNMgHrMCgR7XoJHO/mczPvz9siUa+la3S+ZogI=' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='",
    "style-src 'self' 'unsafe-inline' https://fonts.bunny.net",
    "img-src 'self' data: https:",
    "connect-src 'self' https://ka-f.fontawesome.com",
    "font-src 'self' https://cdn.jsdelivr.net https://fonts.bunny.net",
  ].join("; "));
});

// CORS for API routes
app.use("/api/*", corsMiddleware);

// Demo mode: block mutating /api/* requests with a friendly 403.
// Allowlist: the public password gate (/api/links/:id/check-password). Non-/api/
// writes (e.g. the /:slug password POST) pass through unchanged. POST /api/auth/*
// is intentionally blocked — there is no login flow in demo mode (see src/lib/demo.ts).
const CHECK_PASSWORD_PATH = /^\/api\/links\/[^/]+\/check-password$/;
app.use("*", async (c, next) => {
  if (!isDemoMode(c.env)) return next();
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const path = c.req.path;
  if (!path.startsWith("/api/")) return next();
  if (CHECK_PASSWORD_PATH.test(path)) return next();
  return c.json({ error: DEMO_BLOCKED_MESSAGE, demoMode: true }, 403);
});

// Auth routes (no auth middleware - handles its own)
app.route("/api/auth", authRoutes);

// Public API endpoint: instance config (no auth required — public branding)
app.get("/api/config", (c) => {
  return c.json({
    instanceName: getInstanceName(c.env),
    demoMode: isDemoMode(c.env),
  });
});

// Public API endpoint: password check (no auth required)
app.post("/api/links/:id/check-password", checkPassword);

// Team routes (auth required, session rate limited)
app.use("/api/teams", requireAuth, rateLimitSession);
app.use("/api/teams/*", requireAuth, rateLimitSession);
app.route("/api/teams", teamRoutes);

// Admin routes (auth + admin required, session rate limited)
app.use("/api/admin", requireAuth, requireAdmin, rateLimitSession);
app.use("/api/admin/*", requireAuth, requireAdmin, rateLimitSession);
app.route("/api/admin", adminRoutes);

// Auth middleware for protected API routes (excludes /api/auth/*)
app.use("/api/me", requireAuth);
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
  return c.json({ data: c.var.user! });
});

// Protected API routes
app.route("/api/links", linkRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/campaigns", campaignRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/keys", keyRoutes);
app.route("/api/bulk", bulkRoutes);
app.route("/api/reports", reportRoutes);

// Public report viewer API (no auth, IP rate limited — 30 req/min per IP)
app.get("/api/public-report/:token", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const windowEpoch = Math.floor(Date.now() / 1000 / 60);
  const rlKey = `rl:pub:${ip}:${windowEpoch}`;

  const stored = await c.env.KV.get(rlKey);
  const count = stored ? parseInt(stored, 10) : 0;
  if (count >= 30) {
    const secondsRemaining = 60 - (Math.floor(Date.now() / 1000) % 60);
    return Response.json(
      { error: "Rate limit exceeded", retryAfter: secondsRemaining },
      { status: 429, headers: { "Retry-After": String(secondsRemaining) } }
    );
  }

  // Increment asynchronously — non-blocking, advisory enforcement
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

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
