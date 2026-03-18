import { Hono, type Context } from "hono";
import { eq, desc, sql, and, or, like } from "drizzle-orm";
import { getDb } from "../../db";
import { links, linkStats } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, deleteCachedRedirect } from "../../services/kv-cache";
import { HTTPException } from "hono/http-exception";
import { badRequest, notFound, conflict } from "../../lib/errors";
import { hashPassword, verifyPassword } from "../../services/password";
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

function parseExpiresAt(value: string | number): Date {
  const d = typeof value === "number"
    ? new Date(value < 1e12 ? value * 1000 : value)
    : new Date(value);
  if (isNaN(d.getTime())) throw badRequest("Invalid expiresAt date");
  if (d.getTime() <= Date.now()) throw badRequest("expiresAt must be in the future");
  return d;
}

function parseMaxClicks(value: number): number {
  const mc = Math.floor(value);
  if (!Number.isFinite(mc) || mc < 1) throw badRequest("maxClicks must be a positive integer");
  return mc;
}

function validateOgImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw badRequest("ogImage must be an http or https URL");
    }
    return url;
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw badRequest("ogImage must be a valid URL");
  }
}

/** Strip the password hash from a link record, replacing with hasPassword boolean. */
function stripPassword<T extends { password?: string | null }>(link: T): Omit<T, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = link;
  return { ...rest, hasPassword: !!password };
}

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `ratelimit:pw:${ip}`;
  const current = parseInt(await kv.get(key) || "0", 10);
  if (current >= 5) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 900 });
  return true;
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
    data: items.map(stripPassword),
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

  let body: {
    slug: string;
    destinationUrl: string;
    redirectType?: number;
    title?: string;
    expiresAt?: string | number;
    maxClicks?: number | null;
    password?: string;
    isInternal?: boolean;
    ogTitle?: string;
    ogDescription?: string;
    ogImage?: string;
  };
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

  let expiresAt: Date | null = null;
  if (body.expiresAt != null) {
    expiresAt = parseExpiresAt(body.expiresAt);
  }

  let maxClicks: number | null = null;
  if (body.maxClicks != null) {
    maxClicks = parseMaxClicks(body.maxClicks);
  }

  // Hash password if provided
  let passwordHash: string | null = null;
  if (body.password) {
    passwordHash = await hashPassword(body.password);
  }

  const isInternal = body.isInternal === true;

  const ogTitle = body.ogTitle || null;
  const ogDescription = body.ogDescription || null;
  let ogImage: string | null = null;
  if (body.ogImage) {
    ogImage = validateOgImageUrl(body.ogImage);
  }

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
      expiresAt,
      maxClicks,
      password: passwordHash,
      isInternal,
      ogTitle,
      ogDescription,
      ogImage,
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
    expiresAt: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : null,
    maxClicks: maxClicks,
    hasPassword: !!passwordHash,
    isInternal,
    ogTitle,
    ogDescription,
    ogImage,
  });

  return c.json({
    data: {
      id,
      userId: user.id,
      slug: body.slug,
      destinationUrl: body.destinationUrl,
      redirectType,
      title,
      expiresAt,
      maxClicks,
      hasPassword: !!passwordHash,
      isInternal,
      ogTitle,
      ogDescription,
      ogImage,
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
      ...stripPassword(link),
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

  let body: {
    destinationUrl?: string;
    redirectType?: number;
    title?: string;
    expiresAt?: string | number | null;
    maxClicks?: number | null;
    password?: string | null;
    isInternal?: boolean;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImage?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const updates: Partial<typeof links.$inferInsert> = { updatedAt: new Date() };

  if (body.destinationUrl !== undefined) {
    validateDestinationUrl(body.destinationUrl);
    updates.destinationUrl = body.destinationUrl;
  }

  if (body.redirectType !== undefined) {
    updates.redirectType = body.redirectType === 301 ? 301 : 302;
  }

  if (body.title !== undefined) {
    updates.title = body.title || null;
  }

  if (body.expiresAt !== undefined) {
    updates.expiresAt = body.expiresAt === null ? null : parseExpiresAt(body.expiresAt);
  }

  if (body.maxClicks !== undefined) {
    updates.maxClicks = body.maxClicks === null ? null : parseMaxClicks(body.maxClicks);
  }

  // Handle password: non-empty string = set, null/empty = clear, absent = unchanged
  if (body.password !== undefined) {
    if (body.password === null || body.password === "") {
      updates.password = null;
    } else {
      updates.password = await hashPassword(body.password);
    }
  }

  if (body.isInternal !== undefined) {
    updates.isInternal = body.isInternal === true;
  }

  // Handle OG fields
  if (body.ogTitle !== undefined) {
    updates.ogTitle = body.ogTitle || null;
  }
  if (body.ogDescription !== undefined) {
    updates.ogDescription = body.ogDescription || null;
  }
  if (body.ogImage !== undefined) {
    updates.ogImage = (body.ogImage === null || body.ogImage === "") ? null : validateOgImageUrl(body.ogImage);
  }

  await db.update(links).set(updates).where(eq(links.id, id));

  // Build merged record for KV and response
  const merged = { ...existing, ...updates };
  const newSlug = existing.slug;
  const newUrl = (merged.destinationUrl as string);
  const newRedirectType = (merged.redirectType as number);

  // Determine password state for KV
  const hasPassword = updates.password !== undefined
    ? !!updates.password
    : !!existing.password;

  // Determine expiresAt for KV (as unix timestamp)
  let kvExpiresAt: number | null = null;
  if (merged.expiresAt != null) {
    const d = merged.expiresAt instanceof Date ? merged.expiresAt : new Date(merged.expiresAt as string | number);
    kvExpiresAt = Math.floor(d.getTime() / 1000);
  }

  await setCachedRedirect(c.env.KV, newSlug, {
    url: newUrl,
    redirectType: newRedirectType,
    linkId: id,
    isActive: existing.isActive,
    expiresAt: kvExpiresAt,
    maxClicks: (merged.maxClicks as number | null) ?? null,
    hasPassword,
    isInternal: (merged.isInternal as boolean) ?? false,
    ogTitle: (merged.ogTitle as string | null) ?? null,
    ogDescription: (merged.ogDescription as string | null) ?? null,
    ogImage: (merged.ogImage as string | null) ?? null,
  });

  // Build response — strip password hash
  const response = stripPassword(merged as typeof existing);
  return c.json({ data: response });
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
    let kvExpiresAt: number | null = null;
    if (link.expiresAt) {
      const d = link.expiresAt instanceof Date ? link.expiresAt : new Date(link.expiresAt as unknown as string);
      kvExpiresAt = Math.floor(d.getTime() / 1000);
    }

    await setCachedRedirect(c.env.KV, link.slug, {
      url: link.destinationUrl,
      redirectType: link.redirectType,
      linkId: link.id,
      isActive: true,
      expiresAt: kvExpiresAt,
      maxClicks: link.maxClicks ?? null,
      hasPassword: !!link.password,
      isInternal: link.isInternal ?? false,
      ogTitle: link.ogTitle ?? null,
      ogDescription: link.ogDescription ?? null,
      ogImage: link.ogImage ?? null,
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

/** Public endpoint: verify a link's password via JSON API (no auth required). */
export async function checkPassword(c: Context<AppEnv, "/api/links/:id/check-password">) {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const allowed = await checkRateLimit(c.env.KV, ip);
  if (!allowed) {
    return c.json({ error: "Too many attempts, try again later" }, 429);
  }

  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const link = await db.select({ password: links.password })
    .from(links)
    .where(eq(links.id, id))
    .get();

  if (!link || !link.password) {
    return c.json({ error: "Link not found or has no password" }, 404);
  }

  let body: { password: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.password || typeof body.password !== "string") {
    return c.json({ error: "password is required" }, 400);
  }

  const valid = await verifyPassword(body.password, link.password);
  if (valid) {
    return c.json({ valid: true });
  }
  return c.json({ valid: false });
}

export default linkRoutes;
