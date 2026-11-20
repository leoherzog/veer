import type { Context, Next } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AppEnv } from "../types";
import { getDb, type Database } from "../db";
import { links, domainConfig } from "../db/schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  getCachedRedirect, setCachedRedirect, loadCachedRedirect, toCachedRedirect,
  type CachedRedirect, type CachedTarget,
} from "../services/kv-cache";
import { writeClickEvent, upsertDailyStats, requestVisitor, sumClicks, type Visitor } from "../services/analytics";
import { verifyPassword } from "../services/password";
import { getAuth } from "../auth";
import { getInstanceName } from "../lib/branding";
import { validateSlug } from "../services/slug";
import { parseDevice } from "../services/useragent";
import { checkPasswordRateLimit } from "../middleware/rate-limit";
import { PASSWORD_GATE_CSP } from "../lib/csp";
import { getPrimaryHostname, isHttpUrl } from "../lib/validators";

type SlugContext = Context<AppEnv, "/:slug">;
type Markup = HtmlEscapedString | Promise<HtmlEscapedString>;

/** A self-contained page with `body` under the instance brand block. */
function brandedPage(c: SlugContext, title: string, body: Markup): Markup {
  const instanceName = getInstanceName(c.env);
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - ${instanceName}</title>
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
<div class="brand">${instanceName}</div>
${body}
</div>
</body>
</html>`;
}

function passwordGatePage(c: SlugContext, slug: string, error?: string, status: 200 | 429 = 200) {
  const body = html`<p class="message">This link is password protected</p>
<form method="POST" action="/${encodeURIComponent(slug)}">
<input type="password" name="password" placeholder="Enter password" required autofocus>
<button type="submit">Continue</button>
${error ? html`<p class="error">${error}</p>` : null}
</form>`;
  // Overrides the global policy, whose form-action would block the 302 a
  // correct password returns.
  return c.html(brandedPage(c, "Password Required", body), status, { "Content-Security-Policy": PASSWORD_GATE_CSP });
}

/** A branded page carrying one message: the 410 for an unavailable link, the 403 for an internal one. */
function messagePage(c: SlugContext, title: string, message: string, status: 403 | 410) {
  return c.html(brandedPage(c, title, html`<p class="message">${message}</p>`), status);
}

const BOT_UA_PATTERN = /facebookexternalhit|Twitterbot|LinkedInBot|Discordbot|Slackbot|WhatsApp|Telegram|Googlebot|bingbot|Applebot/i;

/**
 * Crawler preview page. `dest` is null for password-protected links: the meta
 * refresh is the only place the destination would appear, and it must not leave
 * the server until the password is verified.
 */
function ogMetaPage(c: SlugContext, dest: string | null, og: Pick<CachedRedirect, "ogTitle" | "ogDescription" | "ogImage">, shortUrl: string) {
  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${og.ogTitle ? html`<meta property="og:title" content="${og.ogTitle}">` : null}
${og.ogDescription ? html`<meta property="og:description" content="${og.ogDescription}">` : null}
${og.ogImage ? html`<meta property="og:image" content="${og.ogImage}">` : null}
<meta property="og:url" content="${shortUrl}">
${dest ? html`<meta http-equiv="refresh" content="0;url=${dest}">` : null}
<title>${og.ogTitle ?? "Redirecting"}</title>
</head>
<body><p>${dest ? "Redirecting..." : "This link is password protected."}</p></body>
</html>`);
}

/** The link host of a request: its hostname on a custom domain, null on the primary host or a local one, whose links store a NULL domainHostname. */
function requestHost<P extends string>(c: Context<AppEnv, P>): string | null {
  const host = c.req.header("host")?.split(":")[0]?.toLowerCase();
  if (!host || host === getPrimaryHostname(c.env.BETTER_AUTH_URL) || host === "localhost" || host === "127.0.0.1") return null;
  return host;
}

/**
 * The canonical slug of a /:slug request and its link host. `slug` is null when
 * validateSlug rejects it (empty, malformed or reserved), since no link can hold
 * such a slug and looking it up would only cost a KV get and a D1 select.
 */
function slugRequest(c: SlugContext): { slug: string | null; host: string | null } {
  const check = validateSlug(c.req.param("slug"));
  return { slug: check.valid ? check.slug : null, host: requestHost(c) };
}

/** 302 to a custom domain's configured root or not-found URL, or null when it has no http(s) one. */
async function domainRedirect<P extends string>(
  c: Context<AppEnv, P>,
  host: string,
  field: "rootRedirect" | "notFoundRedirect",
): Promise<Response | null> {
  const row = await getDb(c.env.DB).select({ url: domainConfig[field] }).from(domainConfig)
    .where(eq(domainConfig.hostname, host))
    .get();
  return row?.url && isHttpUrl(row.url) ? redirectResponse(c, row.url, 302) : null;
}

/** Look up a slug on one host: custom-domain links carry the hostname, primary-host links NULL. */
function findLink(db: Database, slug: string, hostname: string | null) {
  return db.select().from(links)
    .where(and(eq(links.slug, slug), hostname ? eq(links.domainHostname, hostname) : isNull(links.domainHostname)))
    .get();
}

/** Resolve a slug to cached redirect data, populating KV on miss. */
async function resolveSlug(c: SlugContext, slug: string, hostname: string | null) {
  const cached = await getCachedRedirect(c.env.KV, slug, hostname);
  if (cached) return cached;

  const db = getDb(c.env.DB);
  const link = await findLink(db, slug, hostname);
  if (!link) return null;

  const resolved = await loadCachedRedirect(db, link);
  c.executionCtx.waitUntil(setCachedRedirect(c.env.KV, slug, resolved, hostname));
  return resolved;
}

/** Check expiration, max clicks, and internal-only constraints. Returns a Response if blocked, null if OK. */
async function checkConstraints(c: SlugContext, resolved: CachedRedirect) {
  if (resolved.expiresAt && Date.now() > resolved.expiresAt * 1000) {
    return messagePage(c, "Link Unavailable", "This link has expired.", 410);
  }

  if (resolved.isInternal) {
    let signedIn = false;
    try {
      signedIn = !!(await getAuth(c.env).api.getSession({ headers: c.req.raw.headers }));
    } catch { /* an auth error counts as signed out */ }
    if (!signedIn) return messagePage(c, "Access Denied", "This link requires authentication.", 403);
  }

  // Soft cap: this read and the deferred click upsert are not atomic, so
  // concurrent requests can each pass.
  if (resolved.maxClicks != null && await sumClicks(getDb(c.env.DB), resolved.linkId) >= resolved.maxClicks) {
    return messagePage(c, "Link Unavailable", "This link is no longer available.", 410);
  }

  return null;
}

/** Roll an A/B variant by weight. The link's own URL keeps the rest of 100, floored at 1. */
function rollVariant(variants: CachedTarget[], defaultUrl: string): string {
  const weights = variants.map((t) => Math.max(1, Math.min(99, parseInt(t.matchValue) || 0)));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  // Variants fill [0, totalWeight); the default takes the remainder,
  // floored at 1 so it stays selectable even if stored weights reach 100.
  const roll = Math.random() * (Math.max(1, 100 - totalWeight) + totalWeight);
  let cumulative = 0;
  for (let i = 0; i < variants.length; i++) {
    cumulative += weights[i];
    if (roll < cumulative) return variants[i].destinationUrl;
  }
  return defaultUrl;
}

/**
 * The visitor's target: the highest-priority geo or device rule that matches,
 * else an A/B roll, else the link's own URL. Equal priorities keep stored order.
 * A matched rule never rolls, even when it points at the link's own URL.
 */
function chooseTarget(resolved: CachedRedirect, visitor: Visitor): string {
  const rules: CachedTarget[] = [];
  const variants: CachedTarget[] = [];
  for (const target of resolved.targets ?? []) (target.type === "ab" ? variants : rules).push(target);

  if (rules.length) {
    const country = visitor.country.toUpperCase();
    const device = parseDevice(visitor.userAgent);
    let match: CachedTarget | undefined;
    for (const rule of rules) {
      const hit = rule.type === "geo" ? rule.matchValue.toUpperCase() === country : rule.matchValue.toLowerCase() === device;
      if (hit && (!match || rule.priority > match.priority)) match = rule;
    }
    if (match) return match.destinationUrl;
  }

  return variants.length ? rollVariant(variants, resolved.url) : resolved.url;
}

/**
 * `destination` with the request's query params appended, skipping keys it
 * already has. Its own query string is kept as written, never re-serialized.
 */
function forwardParams(destination: string, requestUrl: string): string {
  const incoming = new URL(requestUrl).searchParams;
  if (!incoming.size) return destination;
  const dest = new URL(destination);
  const forwarded = new URLSearchParams([...incoming].filter(([key]) => !dest.searchParams.has(key)));
  if (!forwarded.size) return destination;
  dest.search = dest.search ? `${dest.search}&${forwarded}` : `${forwarded}`;
  return dest.href;
}

/**
 * Where a request goes. `target` is the chosen destination, which the click
 * records so A/B stats group by variant; `url` adds any forwarded params.
 */
function resolveDestination(c: SlugContext, resolved: CachedRedirect, visitor: Visitor): { target: string; url: string } {
  const target = chooseTarget(resolved, visitor);
  return { target, url: resolved.paramForwarding ? forwardParams(target, c.req.url) : target };
}

/** Fire analytics (sync) and upsert the permanent daily aggregate (background). */
function trackClick(c: SlugContext, slug: string, linkId: string, target: string, visitor: Visitor) {
  writeClickEvent(c.env.ANALYTICS, { linkId, slug, destinationUrl: target, ...visitor });
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

export async function handleRedirect(c: SlugContext, next: Next) {
  const { slug, host } = slugRequest(c);
  const resolved = slug === null ? null : await resolveSlug(c, slug, host);

  // On the primary host an unknown slug falls through to the SPA or a static
  // file; on a custom domain it takes the domain's notFoundRedirect.
  if (slug === null || !resolved) {
    const notFound = host ? await domainRedirect(c, host, "notFoundRedirect") : null;
    return notFound ?? next();
  }

  const blocked = await checkConstraints(c, resolved);
  if (blocked) return blocked;

  const visitor = requestVisitor(c.req.raw);

  // Bot/OG check runs before the password gate so crawlers get previews of
  // protected links. A crawler on a link without OG fields redirects and counts
  // as a click like any visitor.
  const hasOg = resolved.ogTitle || resolved.ogDescription || resolved.ogImage;
  if (hasOg && BOT_UA_PATTERN.test(visitor.userAgent)) {
    const shortUrl = new URL(`/${slug}`, c.req.url).href;
    return ogMetaPage(c, resolved.hasPassword ? null : resolveDestination(c, resolved, visitor).url, resolved, shortUrl);
  }

  if (resolved.hasPassword) return passwordGatePage(c, slug);

  // Targeting and param forwarding run only once the request is going to
  // redirect, so a gated link never spends an A/B roll.
  const destination = resolveDestination(c, resolved, visitor);
  // Hono routes HEAD to the GET handler; only a real GET is a click.
  if (c.req.method === "GET") {
    trackClick(c, slug, resolved.linkId, destination.target, visitor);
  }
  return redirectResponse(c, destination.url, resolved.redirectType);
}

export async function handleRedirectPost(c: SlugContext, next: Next) {
  const { slug, host } = slugRequest(c);
  if (slug === null) return next();

  // D1, not KV: the cache holds no password hash.
  const db = getDb(c.env.DB);
  const link = await findLink(db, slug, host);
  if (!link) return next();

  if (!link.password) {
    return c.text("Method Not Allowed", 405, { Allow: "GET, HEAD" });
  }

  const blocked = await checkConstraints(c, toCachedRedirect(link, null));
  if (blocked) return blocked;

  const formData = await c.req.parseBody();
  const submittedPassword = typeof formData.password === "string" ? formData.password : "";

  if (!submittedPassword) {
    return passwordGatePage(c, slug, "Please enter a password.");
  }

  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const rl = await checkPasswordRateLimit(c.env.KV, link.id, ip);
  if (rl.exceeded) {
    return passwordGatePage(c, slug, "Too many attempts, try again later.", 429);
  }
  c.executionCtx.waitUntil(rl.hit());

  const valid = await verifyPassword(submittedPassword, link.password);
  if (!valid) {
    return passwordGatePage(c, slug, "Incorrect password. Please try again.");
  }

  // Targets load only once the password verifies.
  const resolved = await loadCachedRedirect(db, link);
  const visitor = requestVisitor(c.req.raw);
  const destination = resolveDestination(c, resolved, visitor);
  trackClick(c, slug, link.id, destination.target, visitor);
  return redirectResponse(c, destination.url, resolved.redirectType);
}

/** Handle root path on custom domains (rootRedirect). */
export async function handleCustomDomainRoot(c: Context<AppEnv, "/">, next: Next) {
  const host = requestHost(c);
  const root = host ? await domainRedirect(c, host, "rootRedirect") : null;
  return root ?? next();
}
