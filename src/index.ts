import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import { bodyLimit } from "hono/body-limit";
import { except } from "hono/combine";
import type { AppEnv } from "./types";
import { getAuth } from "./auth";
import { requireAuth, requireAdmin, requireAuthOrApiKey } from "./middleware/auth";
import { rateLimitApiKeyCheck, rateLimitApiKeyIncrement, checkRateLimit } from "./middleware/rate-limit";
import linkRoutes from "./routes/api/links";
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
import { getConfiguredProviders } from "./lib/providers";
import { DEMO_BLOCKED_MESSAGE } from "./lib/demo";
import { scheduled } from "./scheduled";
import { CSP } from "./lib/csp";

export const app = new Hono<AppEnv>();

// Global error handler: consistent JSON errors, no internal detail leaks.
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

// Security headers on every response. Hono runs onError below this middleware,
// so the finally also decorates error responses.
app.use("*", async (c, next) => {
  try {
    await next();
  } finally {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    // A handler that emitted its own policy keeps it: the password gate serves a
    // CSP without form-action.
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", CSP);
    }
  }
});

// One canonical URL per path: /foo/ 301s to /foo. `alwaysRedirect` is required
// because the catch-all serves the SPA with a 200, so the default 404-only mode
// would never fire.
app.use("*", trimTrailingSlash({ alwaysRedirect: true }));

// Demo mode: every mutating /api/* request gets a friendly 403, POST /api/auth/*
// included, since demo has no login flow. Non-/api/ writes such as the /:slug
// password form pass through.
app.use("/api/*", async (c, next) => {
  if (!isDemoMode(c.env)) return next();
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  return c.json({ error: DEMO_BLOCKED_MESSAGE, demoMode: true }, 403);
});

// Request body caps, enforced on streamed bodies too: 10 KB for the JSON API,
// 100 KB for bulk, none for Better Auth.
const tooLarge = (): never => {
  throw new HTTPException(413, { message: "Request body too large" });
};
app.use("/api/*", except(["/api/auth/*", "/api/bulk/*"], bodyLimit({ maxSize: 10_000, onError: tooLarge })));
app.use("/api/bulk/*", bodyLimit({ maxSize: 100_000, onError: tooLarge }));

// Better Auth handles its own auth.
app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth(c.env).handler(c.req.raw));

// Public instance config: branding plus the login options the SPA renders.
app.get("/api/config", (c) => {
  return c.json({
    instanceName: getInstanceName(c.env),
    demoMode: isDemoMode(c.env),
    providers: Object.keys(getConfiguredProviders(c.env)),
    passkey: c.env.PASSKEY_ENABLED === "true",
  });
});

// In Hono `/x/*` also matches `/x`, so each prefix below is registered once.

// Teams and admin are session-only and deliberately unmetered.
app.use("/api/teams/*", requireAuth);
app.route("/api/teams", teamRoutes);

app.use("/api/admin/*", requireAuth, requireAdmin);
app.route("/api/admin", adminRoutes);

// Auth middleware for protected API routes (excludes /api/auth/*).
// rateLimitApiKeyCheck runs first: it keys on the bearer prefix alone, so an
// over-limit key is rejected without spending an HMAC and two D1 queries. The
// counter is only written after authentication, so an unknown key costs no KV write.
app.use("/api/me", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/links/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/stats/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/campaigns/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/domains/*", requireAuth);
app.use("/api/keys/*", requireAuth);
app.use("/api/bulk/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);
app.use("/api/reports/*", rateLimitApiKeyCheck, requireAuthOrApiKey, rateLimitApiKeyIncrement);

// Admin-only domain management routes (sync, individual config, access)
app.post("/api/domains/sync", requireAdmin);
app.get("/api/domains/:hostname", requireAdmin);
app.put("/api/domains/:hostname", requireAdmin);
app.put("/api/domains/:hostname/access", requireAdmin);

app.get("/api/me", async (c) => {
  return c.json({ data: c.var.user! });
});

// Mounted after their auth middleware; Hono runs handlers in registration order.
app.route("/api/links", linkRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/campaigns", campaignRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/keys", keyRoutes);
app.route("/api/bulk", bulkRoutes);
app.route("/api/reports", reportRoutes);

// Public report viewer: no auth, IP rate limited.
app.get("/api/public-report/:token", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const rl = await checkRateLimit(c.env.KV, `rl:pub:${ip}`, 30, 60);
  if (rl.exceeded) {
    return Response.json(
      { error: "Rate limit exceeded", retryAfter: rl.secondsRemaining },
      { status: 429, headers: { "Retry-After": String(rl.secondsRemaining) } }
    );
  }
  c.executionCtx.waitUntil(rl.hit());

  await next();
}, publicReportRoute);

// Unmatched /api/* paths must never reach the SPA shell: API clients get a JSON 404.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Custom domain root redirect (before /:slug to handle bare domain visits)
app.get("/", handleCustomDomainRoot);

// Redirect engine (must come after /api/*), falls through to SPA on miss
app.get("/:slug", handleRedirect);
app.post("/:slug", handleRedirectPost);

// Static assets. The binding applies `not_found_handling: single-page-application`
// from wrangler.jsonc, so a path with no file gets the SPA shell.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
