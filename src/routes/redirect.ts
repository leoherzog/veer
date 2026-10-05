import type { Context, Next } from "hono";
import type { AppEnv } from "../types";
import { getDb, type Database } from "../db";
import { links, domainConfig } from "../db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getCachedRedirect, setCachedRedirect, loadCachedRedirect, type CachedRedirect } from "../services/kv-cache";
import { writeClickEvent, upsertDailyStats, requestVisitor, sumClicks } from "../services/analytics";
import { verifyPassword } from "../services/password";
import { getAuth } from "../auth";
import { getInstanceName } from "../lib/branding";
import { normalizeSlug, RESERVED_SLUGS } from "../services/slug";
import { parseDevice } from "../services/useragent";
import { checkPasswordRateLimit } from "../middleware/rate-limit";
import { PASSWORD_GATE_CSP } from "../lib/csp";
import { getPrimaryHostname, isHttpUrl } from "../lib/validators";

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
      // correct password returns.
      "Content-Security-Policy": PASSWORD_GATE_CSP,
    },
  });
}

/** A branded page carrying one message: the 410 for an unavailable link, the 403 for an internal one. */
function messagePage(title: string, message: string, status: 403 | 410, instanceName: string): Response {
  const body = `
<div class="brand">${escapeHtml(instanceName)}</div>
<p class="message">${escapeHtml(message)}</p>`;
  return new Response(htmlPage(title, body, instanceName), {
    status,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

const BOT_UA_PATTERN = /facebookexternalhit|Twitterbot|LinkedInBot|Discordbot|Slackbot|WhatsApp|Telegram|Googlebot|bingbot|Applebot/i;

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The request's host, and whether it is a custom domain rather than the primary host or a local one. */
function requestHost<P extends string>(c: Context<AppEnv, P>) {
  const host = c.req.header("host")?.split(":")[0]?.toLowerCase() || "";
  const isCustomDomain = host !== getPrimaryHostname(c.env.BETTER_AUTH_URL) && host !== "localhost" && host !== "127.0.0.1";
  return { host, isCustomDomain };
}

/** Look up a slug on one host: custom-domain links carry the hostname, primary-host links NULL. */
function findLink(db: Database, slug: string, hostname: string | null) {
  return db.select().from(links)
    .where(and(eq(links.slug, slug), hostname ? eq(links.domainHostname, hostname) : isNull(links.domainHostname)))
    .get();
}

/** Resolve a slug to cached redirect data, populating KV on miss. */
async function resolveSlug(c: Context<AppEnv, "/:slug">, slug: string, hostname: string | null) {
  let cached = await getCachedRedirect(c.env.KV, slug, hostname);

  if (cached && !cached.isActive) return null;

  if (!cached) {
    const db = getDb(c.env.DB);
    const link = await findLink(db, slug, hostname);
    if (!link || !link.isActive) return null;

    cached = await loadCachedRedirect(db, link);

    c.executionCtx.waitUntil(
      setCachedRedirect(c.env.KV, slug, cached, hostname)
    );
  }

  return cached;
}

/** Check expiration, max clicks, and internal-only constraints. Returns a Response if blocked, null if OK. */
async function checkConstraints(c: Context<AppEnv, "/:slug">, resolved: CachedRedirect) {
  const instanceName = getInstanceName(c.env);

  if (resolved.expiresAt && Date.now() > resolved.expiresAt * 1000) {
    return messagePage("Link Unavailable", "This link has expired.", 410, instanceName);
  }

  if (resolved.isInternal) {
    let signedIn = false;
    try {
      signedIn = !!(await getAuth(c.env).api.getSession({ headers: c.req.raw.headers }));
    } catch { /* an auth error counts as signed out */ }
    if (!signedIn) return messagePage("Access Denied", "This link requires authentication.", 403, instanceName);
  }

  // Soft cap: this read and the deferred click upsert are not atomic, so
  // concurrent requests can each pass.
  if (resolved.maxClicks != null && await sumClicks(getDb(c.env.DB), resolved.linkId) >= resolved.maxClicks) {
    return messagePage("Link Unavailable", "This link is no longer available.", 410, instanceName);
  }

  return null;
}

/** Evaluate targeting rules and param forwarding, returning the final destination URL. */
function resolveDestination(c: Context<AppEnv, "/:slug">, resolved: CachedRedirect): string {
  let destinationUrl = resolved.url;

  if (resolved.targets?.length) {
    const country = (c.req.raw.cf?.country as string) || "";
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

    if (destinationUrl === resolved.url) {
      const abTargets = resolved.targets.filter(t => t.type === "ab");
      if (abTargets.length > 0) {
        const weights = abTargets.map(t => Math.max(1, Math.min(99, parseInt(t.matchValue) || 0)));
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        // Variants fill [0, totalWeight); the default takes the remainder,
        // floored at 1 so it stays selectable even if stored weights reach 100.
        const defaultWeight = Math.max(1, 100 - totalWeight);
        const roll = Math.random() * (defaultWeight + totalWeight);
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
  writeClickEvent(c.env.ANALYTICS, { linkId, slug, destinationUrl, ...requestVisitor(c.req.raw) });
  c.executionCtx.waitUntil(upsertDailyStats(getDb(c.env.DB), linkId, 1));
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
  // /Blah and /blah resolve to the same link.
  const slug = normalizeSlug(c.req.param("slug"));
  if (!slug) return next();
  const { host, isCustomDomain } = requestHost(c);
  // Reserved slugs can never be links (validateSlug rejects them), so skip the
  // lookup. On the primary host they fall through to the SPA or a static file;
  // on a custom domain they take the same notFoundRedirect as any unknown slug.
  const reserved = RESERVED_SLUGS.has(slug);
  if (reserved && !isCustomDomain) return next();

  const resolved = reserved ? null : await resolveSlug(c, slug, isCustomDomain ? host : null);

  if (!resolved) {
    if (isCustomDomain) {
      const domain = await getDb(c.env.DB).select().from(domainConfig)
        .where(eq(domainConfig.hostname, host))
        .get();
      if (domain?.notFoundRedirect && isHttpUrl(domain.notFoundRedirect)) {
        return redirectResponse(c, domain.notFoundRedirect, 302);
      }
    }
    return next();
  }

  const blocked = await checkConstraints(c, resolved);
  if (blocked) return blocked;

  // Bot/OG check runs before the password gate so crawlers get previews of protected links.
  const hasOg = resolved.ogTitle || resolved.ogDescription || resolved.ogImage;
  if (hasOg && BOT_UA_PATTERN.test(c.req.header("user-agent") ?? "")) {
    const shortUrl = new URL(`/${slug}`, c.req.url).href;
    return ogMetaPage(resolved.hasPassword ? null : resolveDestination(c, resolved), resolved, shortUrl);
  }

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
  const { host, isCustomDomain } = requestHost(c);

  // D1, not KV: the cache holds no password hash.
  const db = getDb(c.env.DB);
  const link = await findLink(db, slug, isCustomDomain ? host : null);

  if (!link || !link.isActive) return next();

  if (!link.password) {
    return c.text("Method Not Allowed", 405);
  }

  const resolved = await loadCachedRedirect(db, link);

  const blocked = await checkConstraints(c, resolved);
  if (blocked) return blocked;

  const formData = await c.req.parseBody();
  const submittedPassword = typeof formData.password === "string" ? formData.password : "";

  const instanceName = getInstanceName(c.env);

  if (!submittedPassword) {
    return passwordGatePage(slug, instanceName, "Please enter a password.");
  }

  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const rl = await checkPasswordRateLimit(c.env.KV, link.id, ip);
  if (rl.exceeded) {
    return passwordGatePage(slug, instanceName, "Too many attempts, try again later.", 429);
  }
  c.executionCtx.waitUntil(rl.hit());

  const valid = await verifyPassword(submittedPassword, link.password);
  if (!valid) {
    return passwordGatePage(slug, instanceName, "Incorrect password. Please try again.");
  }

  const destinationUrl = resolveDestination(c, resolved);
  trackClick(c, slug, resolved.linkId, destinationUrl);
  return redirectResponse(c, destinationUrl, resolved.redirectType);
}

/** Handle root path on custom domains (rootRedirect). */
export async function handleCustomDomainRoot(c: Context<AppEnv, "/">, next: Next) {
  const { host, isCustomDomain } = requestHost(c);
  if (!isCustomDomain) return next();

  const db = getDb(c.env.DB);
  const domain = await db.select().from(domainConfig)
    .where(eq(domainConfig.hostname, host))
    .get();

  if (domain?.rootRedirect && isHttpUrl(domain.rootRedirect)) {
    return redirectResponse(c, domain.rootRedirect, 302);
  }

  return next();
}
