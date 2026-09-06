import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import type { AppEnv } from "./types";
import { corsMiddleware } from "./middleware/cors";
import { requireAuth, requireAdmin, requireAuthOrApiKey } from "./middleware/auth";
import { rateLimitApiKeyCheck, rateLimitApiKeyIncrement, checkRateLimit } from "./middleware/rate-limit";
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
import { CSP } from "./lib/csp";

export const app = new Hono<AppEnv>();

/** Security headers every response carries, error responses included. */
function setSecurityHeaders(c: Context<AppEnv>): void {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  // A handler that emitted its own policy keeps it — the password gate serves a
  // CSP without form-action.
  if (!c.finalized || !c.res.headers.has("Content-Security-Policy")) {
    c.header("Content-Security-Policy", CSP);
  }
}

// Global error handler: consistent JSON errors, no internal detail leaks.
// It builds a fresh response, so it re-applies the security headers itself.
app.onError((err, c) => {
  setSecurityHeaders(c);
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
  try {
    await next();
  } finally {
    setSecurityHeaders(c);
  }
});

// One canonical URL per path: /foo/ 301s to /foo. `alwaysRedirect` is required
// because the catch-all serves the SPA with a 200, so the default 404-only mode
// would never fire.
app.use("*", trimTrailingSlash({ alwaysRedirect: true }));

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

// Team routes (auth required). Session traffic is deliberately unmetered — see
// the rate-limiting design decision in AGENTS.md.
app.use("/api/teams", requireAuth);
app.use("/api/teams/*", requireAuth);
app.route("/api/teams", teamRoutes);

// Admin routes (auth + admin required). Session traffic is deliberately unmetered.
app.use("/api/admin", requireAuth, requireAdmin);
app.use("/api/admin/*", requireAuth, requireAdmin);
app.route("/api/admin", adminRoutes);

// Auth middleware for protected API routes (excludes /api/auth/*).
// rateLimitApiKeyCheck runs first: it keys on the bearer prefix alone, so an
// over-limit key is rejected without spending an HMAC and two D1 queries. The
// counter is only written after authentication, so an unknown key costs no KV write.
app.use("/api/me", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/links", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/links/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/stats/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/campaigns", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/campaigns/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/domains", requireAuth);
app.use("/api/domains/*", requireAuth);
app.use("/api/keys", requireAuth);
app.use("/api/keys/*", requireAuth);
app.use("/api/bulk", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/bulk/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/reports", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/reports/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);

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

  const rl = await checkRateLimit(c.env.KV, rlKey, 30, 60);
  if (rl.exceeded) {
    return Response.json(
      { error: "Rate limit exceeded", retryAfter: rl.secondsRemaining },
      { status: 429, headers: { "Retry-After": String(rl.secondsRemaining) } }
    );
  }

  // Increment asynchronously — non-blocking, advisory enforcement
  c.executionCtx.waitUntil(
    c.env.KV.put(rlKey, String(rl.count + 1), rl.stored === null ? { expirationTtl: 120 } : {})
  );

  await next();
}, publicReportRoute);

// Unmatched /api/* paths must never reach the SPA shell: API clients get a JSON 404.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

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
