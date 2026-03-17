import { Hono } from "hono";
import { eq, desc, sql, and, or, like } from "drizzle-orm";
import { getDb } from "../../db";
import { links, linkStats } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, deleteCachedRedirect } from "../../services/kv-cache";
import { HTTPException } from "hono/http-exception";
import { badRequest, notFound, conflict } from "../../lib/errors";
import type { AppEnv } from "../../types";

/** Validate a destination URL: must be parseable and use http(s) scheme. */
function validateDestinationUrl(url: string): void {
  if (!url) throw badRequest("destinationUrl is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("Invalid destination URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("Only http and https URLs are allowed");
  }
}

const linkRoutes = new Hono<AppEnv>();

// List user's links
linkRoutes.get("/", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
  const q = c.req.query("q")?.trim();
  const offset = (page - 1) * limit;

  const escaped = q ? q.replace(/%/g, "\\%").replace(/_/g, "\\_") : "";
  const where = q
    ? and(
        eq(links.userId, user.id),
        or(
          like(links.slug, `%${escaped}%`),
          like(links.title, `%${escaped}%`),
          like(links.destinationUrl, `%${escaped}%`)
        )
      )
    : eq(links.userId, user.id);

  const [items, countResult] = await Promise.all([
    db.select().from(links).where(where).orderBy(desc(links.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(links).where(where),
  ]);

  return c.json({
    data: items,
    pagination: {
      page,
      limit,
      total: countResult[0]?.count ?? 0,
    },
  });
});

// Create link
linkRoutes.post("/", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);

  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > 10_000) {
    throw new HTTPException(413, { message: "Request body too large" });
  }

  let body: { slug: string; destinationUrl: string; redirectType?: number; title?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  validateDestinationUrl(body.destinationUrl);

  const slugCheck = validateSlug(body.slug);
  if (!slugCheck.valid) throw badRequest(slugCheck.error!);

  const redirectType = body.redirectType === 301 ? 301 : 302;
  const title = body.title || null;

  const id = crypto.randomUUID();
  const now = new Date();

  try {
    await db.insert(links).values({
      id,
      userId: user.id,
      slug: body.slug,
      destinationUrl: body.destinationUrl,
      redirectType,
      title,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e: unknown) {
    if (e instanceof Error && (e.message.includes("UNIQUE constraint") || (e.cause instanceof Error && e.cause.message.includes("UNIQUE constraint")))) {
      throw conflict("Slug already taken");
    }
    throw e;
  }

  // Write-through to KV
  await setCachedRedirect(c.env.KV, body.slug, {
    url: body.destinationUrl,
    redirectType,
    linkId: id,
    isActive: true,
  });

  return c.json({
    data: {
      id,
      userId: user.id,
      slug: body.slug,
      destinationUrl: body.destinationUrl,
      redirectType,
      title,
      createdAt: now,
      updatedAt: now,
      isActive: true,
    },
  }, 201);
});

// Get link by ID (with total clicks)
linkRoutes.get("/:id", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const link = await db.select().from(links).where(eq(links.id, id)).get();
  if (!link || link.userId !== user.id) throw notFound("Link not found");

  const statsResult = await db
    .select({ totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)` })
    .from(linkStats)
    .where(eq(linkStats.linkId, id));

  return c.json({
    data: {
      ...link,
      totalClicks: statsResult[0]?.totalClicks ?? 0,
    },
  });
});

// Update link
linkRoutes.put("/:id", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const existing = await db.select().from(links).where(eq(links.id, id)).get();
  if (!existing || existing.userId !== user.id) throw notFound("Link not found");

  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > 10_000) {
    throw new HTTPException(413, { message: "Request body too large" });
  }

  let body: { slug?: string; destinationUrl?: string; redirectType?: number; title?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const updates: Record<string, string | number | Date | null> = { updatedAt: new Date() };

  if (body.destinationUrl !== undefined) {
    validateDestinationUrl(body.destinationUrl);
    updates.destinationUrl = body.destinationUrl;
  }

  if (body.slug !== undefined && body.slug !== existing.slug) {
    const slugCheck = validateSlug(body.slug);
    if (!slugCheck.valid) throw badRequest(slugCheck.error!);
    updates.slug = body.slug;
  }

  if (body.redirectType !== undefined) {
    updates.redirectType = body.redirectType === 301 ? 301 : 302;
  }

  if (body.title !== undefined) {
    updates.title = body.title || null;
  }

  try {
    await db.update(links).set(updates).where(eq(links.id, id));
  } catch (e: unknown) {
    if (e instanceof Error && (e.message.includes("UNIQUE constraint") || (e.cause instanceof Error && e.cause.message.includes("UNIQUE constraint")))) throw conflict("Slug already taken");
    throw e;
  }

  // Invalidate old slug from KV if slug changed
  if (updates.slug && updates.slug !== existing.slug) {
    await deleteCachedRedirect(c.env.KV, existing.slug);
  }

  // Update KV cache with new data
  const newSlug = (updates.slug as string) || existing.slug;
  const newUrl = (updates.destinationUrl as string) || existing.destinationUrl;
  const newRedirectType = (updates.redirectType as number) ?? existing.redirectType;
  await setCachedRedirect(c.env.KV, newSlug, {
    url: newUrl,
    redirectType: newRedirectType,
    linkId: id,
    isActive: existing.isActive,
  });

  // Build response from existing + updates to avoid redundant D1 query
  const updated = { ...existing, ...updates };
  return c.json({ data: updated });
});

// Toggle isActive
linkRoutes.patch("/:id/active", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const { id } = c.req.param();
  const body = await c.req.json<{ isActive: unknown }>();
  const isActive = body.isActive === true || body.isActive === "true" || body.isActive === 1
    ? true : false;

  const link = await db.select().from(links).where(and(eq(links.id, id), eq(links.userId, user.id))).get();
  if (!link) throw notFound("Link not found");

  await db.update(links).set({ isActive, updatedAt: new Date() }).where(eq(links.id, id));

  // Invalidate KV cache when deactivating
  if (!isActive) {
    await deleteCachedRedirect(c.env.KV, link.slug);
  } else {
    // Re-populate KV cache when activating
    await setCachedRedirect(c.env.KV, link.slug, {
      url: link.destinationUrl,
      redirectType: link.redirectType,
      linkId: link.id,
      isActive: true,
    });
  }

  return c.json({ success: true, isActive });
});

// Delete link
linkRoutes.delete("/:id", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const link = await db.select().from(links).where(eq(links.id, id)).get();
  if (!link || link.userId !== user.id) throw notFound("Link not found");

  await db.delete(links).where(eq(links.id, id));
  await deleteCachedRedirect(c.env.KV, link.slug);

  return c.json({ success: true });
});

export default linkRoutes;
