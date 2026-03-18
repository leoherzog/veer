import type { Context, Next } from "hono";
import type { AppEnv } from "../types";
import { getDb } from "../db";
import { links, linkStats } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { getCachedRedirect, setCachedRedirect } from "../services/kv-cache";
import { writeClickEvent, incrementClickStats } from "../services/analytics";
import { verifyPassword } from "../services/password";
import { getAuth } from "../auth";

/** Render a minimal self-contained HTML page. */
function htmlPage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Veer</title>
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

function passwordGatePage(slug: string, error?: string): Response {
  const errorHtml = error ? `<p class="error">${error}</p>` : "";
  const body = `
<div class="brand">Veer</div>
<p class="message">This link is password protected</p>
<form method="POST" action="/${slug}">
<input type="password" name="password" placeholder="Enter password" required autofocus>
<button type="submit">Continue</button>
${errorHtml}
</form>`;
  return new Response(htmlPage("Password Required", body), {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

function gonePage(message: string): Response {
  const body = `
<div class="brand">Veer</div>
<p class="message">${message}</p>`;
  return new Response(htmlPage("Link Unavailable", body), {
    status: 410,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

const BOT_UA_PATTERN = /facebookexternalhit|Twitterbot|LinkedInBot|Discordbot|Slackbot|WhatsApp|Telegram|Googlebot|bingbot|Applebot/i;

function isBotRequest(c: Context<AppEnv, "/:slug">): boolean {
  const ua = c.req.header("user-agent") ?? "";
  return BOT_UA_PATTERN.test(ua);
}

function ogMetaPage(slug: string, dest: string, og: { ogTitle: string | null; ogDescription: string | null; ogImage: string | null }, shortUrl: string): Response {
  const tags: string[] = [];
  if (og.ogTitle) tags.push(`<meta property="og:title" content="${escapeHtml(og.ogTitle)}">`);
  if (og.ogDescription) tags.push(`<meta property="og:description" content="${escapeHtml(og.ogDescription)}">`);
  if (og.ogImage) tags.push(`<meta property="og:image" content="${escapeHtml(og.ogImage)}">`);
  tags.push(`<meta property="og:url" content="${escapeHtml(shortUrl)}">`);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${tags.join("\n")}
<meta http-equiv="refresh" content="0;url=${escapeHtml(dest)}">
<title>${escapeHtml(og.ogTitle ?? "Redirecting")}</title>
</head>
<body><p>Redirecting...</p></body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function forbiddenPage(): Response {
  const body = `
<div class="brand">Veer</div>
<p class="message">This link requires authentication.</p>`;
  return new Response(htmlPage("Access Denied", body), {
    status: 403,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

/** Resolve a slug to cached redirect data, populating KV on miss. */
async function resolveSlug(c: Context<AppEnv, "/:slug">, slug: string) {
  let cached = await getCachedRedirect(c.env.KV, slug);

  if (cached && !cached.isActive) return null;

  if (!cached) {
    const db = getDb(c.env.DB);
    const link = await db.select().from(links)
      .where(eq(links.slug, slug))
      .get();

    if (!link || !link.isActive) return null;

    cached = {
      url: link.destinationUrl,
      redirectType: link.redirectType,
      linkId: link.id,
      isActive: link.isActive,
      expiresAt: link.expiresAt ? Math.floor(new Date(link.expiresAt).getTime() / 1000) : null,
      maxClicks: link.maxClicks ?? null,
      hasPassword: !!link.password,
      isInternal: link.isInternal ?? false,
      ogTitle: link.ogTitle ?? null,
      ogDescription: link.ogDescription ?? null,
      ogImage: link.ogImage ?? null,
    };

    c.executionCtx.waitUntil(
      setCachedRedirect(c.env.KV, slug, cached)
    );
  }

  return cached;
}

/** Check expiration, max clicks, and internal-only constraints. Returns a Response if blocked, null if OK. */
async function checkConstraints(c: Context<AppEnv, "/:slug">, resolved: NonNullable<Awaited<ReturnType<typeof resolveSlug>>>) {
  // Expiration check
  if (resolved.expiresAt && Date.now() > resolved.expiresAt * 1000) {
    return gonePage("This link has expired.");
  }

  // Internal link check
  if (resolved.isInternal) {
    try {
      const auth = getAuth(c.env);
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return forbiddenPage();
    } catch {
      return forbiddenPage();
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
      return gonePage("This link is no longer available.");
    }
  }

  return null;
}

/** Fire analytics and increment stats in the background. */
function trackClick(c: Context<AppEnv, "/:slug">, slug: string, resolved: { linkId: string; url: string }) {
  writeClickEvent(c.env.ANALYTICS, {
    linkId: resolved.linkId,
    slug,
    destinationUrl: resolved.url,
    request: c.req.raw,
  });
  c.executionCtx.waitUntil(
    incrementClickStats(getDb(c.env.DB), resolved.linkId)
  );
}

export async function handleRedirect(c: Context<AppEnv, "/:slug">, next: Next) {
  const slug = c.req.param("slug");
  const resolved = await resolveSlug(c, slug);
  if (!resolved) return next();

  // Check constraints (expiration, internal, max clicks)
  const blocked = await checkConstraints(c, resolved);
  if (blocked) return blocked;

  // Password gate — serve the form on GET
  if (resolved.hasPassword) {
    return passwordGatePage(slug);
  }

  const hasOg = resolved.ogTitle || resolved.ogDescription || resolved.ogImage;
  if (hasOg && isBotRequest(c)) {
    const shortUrl = new URL(`/${slug}`, c.req.url).href;
    return ogMetaPage(slug, resolved.url, resolved, shortUrl);
  }

  trackClick(c, slug, resolved);
  return c.redirect(resolved.url, resolved.redirectType as 301 | 302);
}

export async function handleRedirectPost(c: Context<AppEnv, "/:slug">, next: Next) {
  const slug = c.req.param("slug");
  const resolved = await resolveSlug(c, slug);
  if (!resolved) return next();

  // POST is only for password-protected links
  if (!resolved.hasPassword) {
    return c.text("Method Not Allowed", 405);
  }

  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const rlKey = `ratelimit:pw:${ip}`;
  const rlCurrent = parseInt(await c.env.KV.get(rlKey) || "0", 10);
  if (rlCurrent >= 5) {
    return c.json({ error: "Too many attempts, try again later" }, 429);
  }
  await c.env.KV.put(rlKey, String(rlCurrent + 1), { expirationTtl: 900 });

  // Check constraints before processing password
  const blocked = await checkConstraints(c, resolved);
  if (blocked) return blocked;

  // Parse form body
  const formData = await c.req.parseBody();
  const submittedPassword = typeof formData.password === "string" ? formData.password : "";

  if (!submittedPassword) {
    return passwordGatePage(slug, "Please enter a password.");
  }

  // Look up link in D1 to get stored password hash
  const db = getDb(c.env.DB);
  const link = await db.select({ password: links.password, destinationUrl: links.destinationUrl })
    .from(links)
    .where(eq(links.slug, slug))
    .get();

  if (!link || !link.password) {
    return next();
  }

  const valid = await verifyPassword(submittedPassword, link.password);
  if (!valid) {
    return passwordGatePage(slug, "Incorrect password. Please try again.");
  }

  // Password correct — track and redirect
  trackClick(c, slug, resolved);
  return c.redirect(resolved.url, resolved.redirectType as 301 | 302);
}
