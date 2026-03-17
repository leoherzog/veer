import type { Context, Next } from "hono";
import type { AppEnv } from "../types";
import { getDb } from "../db";
import { links } from "../db/schema";
import { eq } from "drizzle-orm";
import { getCachedRedirect, setCachedRedirect } from "../services/kv-cache";
import { writeClickEvent, incrementClickStats } from "../services/analytics";

export async function handleRedirect(c: Context<AppEnv, "/:slug">, next: Next) {
  const slug = c.req.param("slug");

  // Try KV cache first
  let cached = await getCachedRedirect(c.env.KV, slug);

  if (cached && !cached.isActive) {
    return next();
  }

  if (!cached) {
    // Fallback to D1
    const db = getDb(c.env.DB);
    const link = await db.select().from(links)
      .where(eq(links.slug, slug))
      .get();

    if (!link || !link.isActive) {
      return next();
    }

    cached = {
      url: link.destinationUrl,
      redirectType: link.redirectType,
      linkId: link.id,
      isActive: link.isActive,
    };

    // Populate KV cache on miss
    c.executionCtx.waitUntil(
      setCachedRedirect(c.env.KV, slug, cached)
    );
  }

  const resolved = cached;

  // Fire analytics (sync) + increment stats (async) in background
  writeClickEvent(c.env.ANALYTICS, {
    linkId: resolved.linkId,
    slug,
    destinationUrl: resolved.url,
    request: c.req.raw,
  });
  c.executionCtx.waitUntil(
    incrementClickStats(getDb(c.env.DB), resolved.linkId)
  );

  return c.redirect(resolved.url, resolved.redirectType as 301 | 302);
}
