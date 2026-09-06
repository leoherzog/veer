import type { Context, Next } from "hono";
import type { AppEnv } from "../types";
import { getDb } from "../db";
import { links, linkStats, linkTargets, domainConfig } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getCachedRedirect, setCachedRedirect, toCachedRedirect } from "../services/kv-cache";
import { writeClickEvent, upsertDailyStats } from "../services/analytics";
import { verifyPassword } from "../services/password";
import { getAuth } from "../auth";
import { getInstanceName } from "../lib/branding";
import { normalizeSlug, RESERVED_SLUGS } from "../services/slug";
import { parseDevice } from "../services/useragent";
import { checkRateLimit } from "../middleware/rate-limit";
import { PASSWORD_GATE_CSP } from "../lib/csp";

/** Password attempts allowed per IP per link, matching /api/links/:id/check-password. */
const PW_ATTEMPT_LIMIT = 5;
const PW_ATTEMPT_WINDOW_SECONDS = 900;

/** Render a minimal self-contained HTML page. */
function htmlPage(title: string, bodyHtml: string, instanceName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - ${escapeHtml(instanceName)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e5e5e5}}
.container{max-width:400px;width:100%;padding:2rem;text-align:center}
.brand{font-size:1.5rem;font-weight:700;margin-bottom:1.5rem;letter-spacing:-0.02em}
.message{margin-bottom:1.5rem;color:#666}
@media(prefers-color-scheme:dark){.message{color:#999}}
form{display:flex;flex-direction:column;gap:0.75rem}
input[type="password"]{padding:0.75rem 1rem;border:1px solid #ddd;border-radius:8px;font-size:1rem;background:#fff;color:#1a1a1a}
@media(prefers-color-scheme:dark){input[type="password"]{background:#2a2a2a;border-color:#444;color:#e5e5e5}}
button{padding:0.75rem 1rem;border:none;border-radius:8px;font-size:1rem;font-weight:600;background:#3b82f6;color:#fff;cursor:pointer}
button:hover{background:#2563eb}
.error{color:#ef4444;font-size:0.875rem;margin-top:0.25rem}
</style>
</head>
<body>
<div class="container">
${bodyHtml}
</div>
</body>
</html>`;
}

function passwordGatePage(slug: string, instanceName: string, error?: string, status: 200 | 429 = 200): Response {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const body = `
<div class="brand">${escapeHtml(instanceName)}</div>
<p class="message">This link is password protected</p>
<form method="POST" action="/${escapeHtml(encodeURIComponent(slug))}">
<input type="password" name="password" placeholder="Enter password" required autofocus>
<button type="submit">Continue</button>
${errorHtml}
</form>`;
  return new Response(htmlPage("Password Required", body, instanceName), {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      // Overrides the global policy, whose form-action would block the 302 a
      // correct password returns. See src/lib/csp.ts.
      "Content-Security-Policy": PASSWORD_GATE_CSP,
    },
  });
}

function gonePage(message: string, instanceName: string): Response {
  const body = `
<div class="brand">${escapeHtml(instanceName)}</div>
<p class="message">${escapeHtml(message)}</p>`;
  return new Response(htmlPage("Link Unavailable", body, instanceName), {
    status: 410,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

const BOT_UA_PATTERN = /facebookexternalhit|Twitterbot|LinkedInBot|Discordbot|Slackbot|WhatsApp|Telegram|Googlebot|bingbot|Applebot/i;

function isBotRequest(c: Context<AppEnv, "/:slug">): boolean {
  const ua = c.req.header("user-agent") ?? "";
  return BOT_UA_PATTERN.test(ua);
}

/**
 * Crawler preview page. `dest` is null for password-protected links: the meta
 * refresh is the only place the destination would appear, and it must not leave
 * the server until the password is verified.
 */
function ogMetaPage(dest: string | null, og: { ogTitle: string | null; ogDescription: string | null; ogImage: string | null }, shortUrl: string): Response {
  const tags: string[] = [];
  if (og.ogTitle) tags.push(`<meta property="og:title" content="${escapeHtml(og.ogTitle)}">`);
  if (og.ogDescription) tags.push(`<meta property="og:description" content="${escapeHtml(og.ogDescription)}">`);
  if (og.ogImage) tags.push(`<meta property="og:image" content="${escapeHtml(og.ogImage)}">`);
  tags.push(`<meta property="og:url" content="${escapeHtml(shortUrl)}">`);
  if (dest) tags.push(`<meta http-equiv="refresh" content="0;url=${escapeHtml(dest)}">`);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${tags.join("\n")}
<title>${escapeHtml(og.ogTitle ?? "Redirecting")}</title>
</head>
<body><p>${dest ? "Redirecting..." : "This link is password protected."}</p></body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

/** Returns true if the URL is an absolute HTTP(S) URL. */
function isSafeRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function forbiddenPage(instanceName: string): Response {
  const body = `
<div class="brand">${escapeHtml(instanceName)}</div>
<p class="message">This link requires authentication.</p>`;
  return new Response(htmlPage("Access Denied", body, instanceName), {
    status: 403,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

/** Check whether a host is a custom domain (not primary, localhost, or 127.0.0.1). */
function isCustomDomainHost(host: string, primaryUrl: string): boolean {
  const primaryHost = new URL(primaryUrl).hostname;
  return host !== primaryHost && host !== "localhost" && host !== "127.0.0.1";
}

/** Determine if the request is for a custom domain vs the primary domain. */
function resolveHostInfo(c: Context<AppEnv, "/:slug">) {
  const host = c.req.header("host")?.split(":")[0]?.toLowerCase() || "";
  const isCustomDomain = isCustomDomainHost(host, c.env.BETTER_AUTH_URL);
  return { host, isCustomDomain };
}

/** Resolve a slug to cached redirect data, populating KV on miss. */
async function resolveSlug(c: Context<AppEnv, "/:slug">, slug: string, hostname?: string | null) {
  let cached = await getCachedRedirect(c.env.KV, slug, hostname);

  if (cached && !cached.isActive) return null;

  if (!cached) {
    const db = getDb(c.env.DB);

    // Scope slug lookup by domain: custom domain links have domainHostname set,
    // default domain links have domainHostname NULL
    const whereClause = hostname
      ? and(eq(links.slug, slug), eq(links.domainHostname, hostname))
      : and(eq(links.slug, slug), sql`${links.domainHostname} IS NULL`);

    const link = await db.select().from(links).where(whereClause).get();

    if (!link || !link.isActive) return null;

    // Fetch targeting rules for this link
    const targets = await db.select().from(linkTargets)
      .where(eq(linkTargets.linkId, link.id));

    cached = toCachedRedirect(link, targets.length > 0 ? targets.map(t => ({
      type: t.type as "geo" | "device" | "ab",
      matchValue: t.matchValue,
      destinationUrl: t.destinationUrl,
      priority: t.priority,
    })) : null);

    c.executionCtx.waitUntil(
      setCachedRedirect(c.env.KV, slug, cached, hostname)
    );
  }

  return cached;
}

/** Check expiration, max clicks, and internal-only constraints. Returns a Response if blocked, null if OK. */
async function checkConstraints(c: Context<AppEnv, "/:slug">, resolved: NonNullable<Awaited<ReturnType<typeof resolveSlug>>>) {
  const instanceName = getInstanceName(c.env);

  // Expiration check
  if (resolved.expiresAt && Date.now() > resolved.expiresAt * 1000) {
    return gonePage("This link has expired.", instanceName);
  }

  // Internal link check
  if (resolved.isInternal) {
    try {
      const auth = getAuth(c.env);
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return forbiddenPage(instanceName);
    } catch {
      return forbiddenPage(instanceName);
    }
  }

  // Max clicks check (soft cap: concurrent requests may slightly exceed maxClicks
  // since the check and increment are not atomic across D1 tables)
  if (resolved.maxClicks != null) {
    const db = getDb(c.env.DB);
    const statsResult = await db
      .select({ totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)` })
      .from(linkStats)
      .where(eq(linkStats.linkId, resolved.linkId));
    const total = statsResult[0]?.totalClicks ?? 0;
    if (total >= resolved.maxClicks) {
      return gonePage("This link is no longer available.", instanceName);
    }
  }

  return null;
}

/** Evaluate targeting rules and param forwarding, returning the final destination URL. */
function resolveDestination(c: Context<AppEnv, "/:slug">, resolved: NonNullable<Awaited<ReturnType<typeof resolveSlug>>>): string {
  let destinationUrl = resolved.url;

  // Evaluate targeting rules (higher priority first, first match wins)
  if (resolved.targets?.length) {
    const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf;
    const country = (cf?.country as string) || "";
    const ua = c.req.header("user-agent") || "";
    const device = parseDevice(ua);

    const sorted = [...resolved.targets].sort((a, b) => b.priority - a.priority);
    for (const target of sorted) {
      if (target.type === "geo" && target.matchValue.toUpperCase() === country.toUpperCase()) {
        destinationUrl = target.destinationUrl;
        break;
      }
      if (target.type === "device" && target.matchValue.toLowerCase() === device) {
        destinationUrl = target.destinationUrl;
        break;
      }
    }

    // A/B testing: weighted random selection among "ab" variants + default
    if (destinationUrl === resolved.url) {
      const abTargets = resolved.targets.filter(t => t.type === "ab");
      if (abTargets.length > 0) {
        const weights = abTargets.map(t => Math.max(1, Math.min(99, parseInt(t.matchValue) || 0)));
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        // Weights are validated to sum to < 100; the remainder goes to the
        // default destination. Math.max(1, …) floors the default share so it
        // stays selectable even if malformed data pushes the sum to >= 100.
        const defaultWeight = Math.max(1, 100 - totalWeight);
        const roll = Math.random() * (defaultWeight + totalWeight);
        // Variants occupy [0, totalWeight); the default is the fall-through
        // tail [totalWeight, totalWeight + defaultWeight), so destinationUrl
        // stays resolved.url when no variant bucket matches.
        let cumulative = 0;
        for (let i = 0; i < abTargets.length; i++) {
          cumulative += weights[i];
          if (roll < cumulative) {
            destinationUrl = abTargets[i].destinationUrl;
            break;
          }
        }
      }
    }
  }

  // Param forwarding: append incoming params not already in the destination
  if (resolved.paramForwarding) {
    const incomingUrl = new URL(c.req.url);
    if (incomingUrl.search) {
      const dest = new URL(destinationUrl);
      const destKeys = new Set(dest.searchParams.keys());
      for (const [key, value] of incomingUrl.searchParams) {
        if (!destKeys.has(key)) {
          dest.searchParams.append(key, value);
        }
      }
      destinationUrl = dest.toString();
    }
  }

  return destinationUrl;
}

/** Fire analytics (sync) and upsert the permanent daily aggregate (background). */
function trackClick(c: Context<AppEnv, "/:slug">, slug: string, linkId: string, destinationUrl: string) {
  if (c.env.ANALYTICS) {
    writeClickEvent(c.env.ANALYTICS, {
      linkId,
      slug,
      destinationUrl,
      request: c.req.raw,
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  c.executionCtx.waitUntil(upsertDailyStats(getDb(c.env.DB), linkId, today, 1));
}

/**
 * Emit a redirect. 302s carry `Cache-Control: private, no-store` because the
 * destination is decided per request (expiry, max clicks, A/B, geo, password),
 * so a shared or browser cache must never replay one.
 */
function redirectResponse<P extends string>(c: Context<AppEnv, P>, url: string, redirectType: number): Response {
  if (redirectType === 301) return c.redirect(url, 301);
  c.header("Cache-Control", "private, no-store");
  return c.redirect(url, 302);
}

export async function handleRedirect(c: Context<AppEnv, "/:slug">, next: Next) {
  // Slugs are stored normalized, so the incoming one is normalized too:
  // /Blah and /blah resolve to the same link. See services/slug.ts.
  const slug = normalizeSlug(c.req.param("slug"));
  if (!slug) return next();
  const { host, isCustomDomain } = resolveHostInfo(c);
  // Reserved slugs can never be links (validateSlug rejects them), so skip the
  // lookup. On the primary host they fall through to the SPA or a static file;
  // on a custom domain they take the same notFoundRedirect as any unknown slug.
  const reserved = RESERVED_SLUGS.has(slug);
  if (reserved && !isCustomDomain) return next();

  const resolved = reserved ? null : await resolveSlug(c, slug, isCustomDomain ? host : null);

  if (!resolved) {
    // Custom domain: check notFoundRedirect before falling through
    if (isCustomDomain) {
      const domain = await getDb(c.env.DB).select().from(domainConfig)
        .where(eq(domainConfig.hostname, host))
        .get();
      if (domain?.notFoundRedirect && isSafeRedirectUrl(domain.notFoundRedirect)) {
        return redirectResponse(c, domain.notFoundRedirect, 302);
      }
    }
    return next();
  }

  // Check constraints (expiration, internal, max clicks)
  const blocked = await checkConstraints(c, resolved);
  if (blocked) return blocked;

  // Bot/OG check BEFORE password gate — bots should see OG meta tags even for protected links
  const hasOg = resolved.ogTitle || resolved.ogDescription || resolved.ogImage;
  if (hasOg && isBotRequest(c)) {
    const shortUrl = new URL(`/${slug}`, c.req.url).href;
    return ogMetaPage(resolved.hasPassword ? null : resolveDestination(c, resolved), resolved, shortUrl);
  }

  // Password gate — serve the form on GET
  if (resolved.hasPassword) {
    return passwordGatePage(slug, getInstanceName(c.env));
  }

  // Targeting and param forwarding run only once the request is going to
  // redirect, so a gated link never spends an A/B roll.
  const destinationUrl = resolveDestination(c, resolved);
  // Hono routes HEAD to the GET handler; only a real GET is a click.
  if (c.req.method === "GET") {
    trackClick(c, slug, resolved.linkId, destinationUrl);
  }
  return redirectResponse(c, destinationUrl, resolved.redirectType);
}

export async function handleRedirectPost(c: Context<AppEnv, "/:slug">, next: Next) {
  const slug = normalizeSlug(c.req.param("slug"));
  if (!slug) return next();
  if (RESERVED_SLUGS.has(slug)) return next();
  const { host, isCustomDomain } = resolveHostInfo(c);

  const hostname = isCustomDomain ? host : null;

  // Query D1 directly — no need to go through KV cache on the POST path
  const db = getDb(c.env.DB);
  const whereClause = hostname
    ? and(eq(links.slug, slug), eq(links.domainHostname, hostname))
    : and(eq(links.slug, slug), sql`${links.domainHostname} IS NULL`);
  const link = await db.select().from(links).where(whereClause).get();

  if (!link || !link.isActive) return next();

  // POST is only for password-protected links
  if (!link.password) {
    return c.text("Method Not Allowed", 405);
  }

  // Build resolved shape for checkConstraints and resolveDestination
  const targets = await db.select().from(linkTargets)
    .where(eq(linkTargets.linkId, link.id));
  const resolved = toCachedRedirect(link, targets.length > 0 ? targets.map(t => ({
    type: t.type as "geo" | "device" | "ab",
    matchValue: t.matchValue,
    destinationUrl: t.destinationUrl,
    priority: t.priority,
  })) : null);

  // Check constraints before processing password
  const blocked = await checkConstraints(c, resolved);
  if (blocked) return blocked;

  // Parse form body
  const formData = await c.req.parseBody();
  const submittedPassword = typeof formData.password === "string" ? formData.password : "";

  const instanceName = getInstanceName(c.env);

  if (!submittedPassword) {
    return passwordGatePage(slug, instanceName, "Please enter a password.");
  }

  // Brute-force protection: same limit and KV key shape as
  // POST /api/links/:id/check-password, the other way to guess this password.
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const windowEpoch = Math.floor(Date.now() / 1000 / PW_ATTEMPT_WINDOW_SECONDS);
  const rlKey = `rl:pw:${link.id}:${ip}:${windowEpoch}`;
  const rl = await checkRateLimit(c.env.KV, rlKey, PW_ATTEMPT_LIMIT, PW_ATTEMPT_WINDOW_SECONDS);
  if (rl.exceeded) {
    return passwordGatePage(slug, instanceName, "Too many attempts, try again later.", 429);
  }
  c.executionCtx.waitUntil(
    c.env.KV.put(rlKey, String(rl.count + 1), rl.stored === null ? { expirationTtl: PW_ATTEMPT_WINDOW_SECONDS * 2 } : {})
  );

  const valid = await verifyPassword(submittedPassword, link.password);
  if (!valid) {
    return passwordGatePage(slug, instanceName, "Incorrect password. Please try again.");
  }

  // Password correct — resolve targeting + param forwarding, then track and redirect
  const destinationUrl = resolveDestination(c, resolved);
  trackClick(c, slug, resolved.linkId, destinationUrl);
  return redirectResponse(c, destinationUrl, resolved.redirectType);
}

/** Handle root path on custom domains (rootRedirect). */
export async function handleCustomDomainRoot(c: Context<AppEnv, "/">, next: Next) {
  const host = c.req.header("host")?.split(":")[0]?.toLowerCase() || "";
  if (!isCustomDomainHost(host, c.env.BETTER_AUTH_URL)) {
    return next();
  }

  const db = getDb(c.env.DB);
  const domain = await db.select().from(domainConfig)
    .where(eq(domainConfig.hostname, host))
    .get();

  if (!domain) return next();

  if (domain.rootRedirect && isSafeRedirectUrl(domain.rootRedirect)) {
    return redirectResponse(c, domain.rootRedirect, 302);
  }

  // Custom domain root with no redirect configured — fall through to SPA
  return next();
}
