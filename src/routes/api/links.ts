import { Hono, type Context } from "hono";
import { eq, desc, asc, sql, and, or, like } from "drizzle-orm";
import { getDb } from "../../db";
import { links, linkStats, linkTargets, linkCampaigns, campaigns } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, deleteCachedRedirect } from "../../services/kv-cache";
import { HTTPException } from "hono/http-exception";
import { badRequest, notFound, conflict } from "../../lib/errors";
import { hashPassword, verifyPassword } from "../../services/password";
import type { AppEnv } from "../../types";
import type { CachedRedirect, CachedTarget } from "../../services/kv-cache";
import type { Database } from "../../db";

/** Build a CachedRedirect object from link data + optional targets. */
async function buildCachedRedirect(
  db: Database,
  link: { id: string; destinationUrl: string; redirectType: number; isActive: boolean | number;
    expiresAt: Date | string | number | null; maxClicks: number | null; password: string | null;
    isInternal: boolean | number; ogTitle: string | null; ogDescription: string | null;
    ogImage: string | null; paramForwarding: boolean | number },
  preloadedTargets?: CachedTarget[] | null,
): Promise<CachedRedirect> {
  let kvExpiresAt: number | null = null;
  if (link.expiresAt != null) {
    const d = link.expiresAt instanceof Date ? link.expiresAt : new Date(link.expiresAt as string | number);
    kvExpiresAt = Math.floor(d.getTime() / 1000);
  }

  let targets: CachedTarget[] | null;
  if (preloadedTargets !== undefined) {
    targets = preloadedTargets;
  } else {
    const rows = await db.select().from(linkTargets).where(eq(linkTargets.linkId, link.id));
    targets = rows.length > 0
      ? rows.map(t => ({ type: t.type as "geo" | "device", matchValue: t.matchValue, destinationUrl: t.destinationUrl, priority: t.priority }))
      : null;
  }

  return {
    url: link.destinationUrl,
    redirectType: link.redirectType as number,
    linkId: link.id,
    isActive: !!link.isActive,
    expiresAt: kvExpiresAt,
    maxClicks: link.maxClicks ?? null,
    hasPassword: !!link.password,
    isInternal: !!link.isInternal,
    ogTitle: link.ogTitle ?? null,
    ogDescription: link.ogDescription ?? null,
    ogImage: link.ogImage ?? null,
    paramForwarding: !!link.paramForwarding,
    targets,
  };
}

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

  const sortParam = c.req.query("sort");
  const dirParam = c.req.query("dir");
  const SORTABLE_COLUMNS = { slug: links.slug, createdAt: links.createdAt, title: links.title, destinationUrl: links.destinationUrl } as const;
  const sortCol = SORTABLE_COLUMNS[sortParam as keyof typeof SORTABLE_COLUMNS] ?? links.createdAt;
  const sortDir = dirParam === "asc" ? asc : desc;

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
    db.select().from(links).where(where).orderBy(sortDir(sortCol)).limit(limit).offset(offset),
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
    paramForwarding?: boolean;
    campaignId?: string | null;
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
  const paramForwarding = body.paramForwarding === true;

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
      paramForwarding,
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
  const kvData = await buildCachedRedirect(db, {
    id, destinationUrl: body.destinationUrl, redirectType, isActive: true,
    expiresAt, maxClicks, password: passwordHash, isInternal, ogTitle, ogDescription, ogImage, paramForwarding,
  }, null);
  await setCachedRedirect(c.env.KV, body.slug, kvData);

  // Handle campaign association on create
  if (body.campaignId) {
    const campaign = await db.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.id, body.campaignId), eq(campaigns.userId, user.id))).get();
    if (campaign) {
      await db.insert(linkCampaigns).values({ linkId: id, campaignId: body.campaignId })
        .onConflictDoNothing();
    }
  }

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
      paramForwarding,
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

  const [statsResult, targets, linkedCampaigns] = await Promise.all([
    db.select({ totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)` })
      .from(linkStats)
      .where(eq(linkStats.linkId, id)),
    db.select().from(linkTargets).where(eq(linkTargets.linkId, id)),
    db.select({
        id: campaigns.id,
        name: campaigns.name,
      })
      .from(linkCampaigns)
      .innerJoin(campaigns, eq(linkCampaigns.campaignId, campaigns.id))
      .where(eq(linkCampaigns.linkId, id)),
  ]);

  return c.json({
    data: {
      ...stripPassword(link),
      totalClicks: statsResult[0]?.totalClicks ?? 0,
      targets,
      campaigns: linkedCampaigns,
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
    paramForwarding?: boolean;
    campaignId?: string | null;
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

  if (body.paramForwarding !== undefined) {
    updates.paramForwarding = body.paramForwarding === true;
  }

  await db.update(links).set(updates).where(eq(links.id, id));

  // Handle campaign association update
  if (body.campaignId !== undefined) {
    // Validate new campaignId ownership BEFORE deleting existing associations
    if (body.campaignId) {
      const campaign = await db.select({ id: campaigns.id }).from(campaigns)
        .where(and(eq(campaigns.id, body.campaignId), eq(campaigns.userId, user.id))).get();
      if (!campaign) throw badRequest("Campaign not found or does not belong to you");
    }
    // Remove existing campaign associations
    await db.delete(linkCampaigns).where(eq(linkCampaigns.linkId, id));
    // Add new association if specified
    if (body.campaignId) {
      await db.insert(linkCampaigns).values({ linkId: id, campaignId: body.campaignId });
    }
  }

  // Build merged record for KV and response
  const merged = { ...existing, ...updates };
  // Determine password for KV (updates may have changed it)
  const mergedPassword = updates.password !== undefined ? (updates.password as string | null) : existing.password;

  const kvData = await buildCachedRedirect(db, { ...merged, id, password: mergedPassword } as any);
  await setCachedRedirect(c.env.KV, existing.slug, kvData);

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

  // Invalidate KV cache when deactivating, re-populate when activating
  if (!isActive) {
    await deleteCachedRedirect(c.env.KV, link.slug);
  } else {
    const kvData = await buildCachedRedirect(db, { ...link, isActive: true } as any);
    await setCachedRedirect(c.env.KV, link.slug, kvData);
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

// GET /api/links/:id/targets - list targeting rules
linkRoutes.get("/:id/targets", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const link = await db.select({ id: links.id, userId: links.userId }).from(links).where(eq(links.id, id)).get();
  if (!link || link.userId !== user.id) throw notFound("Link not found");

  const targets = await db.select().from(linkTargets).where(eq(linkTargets.linkId, id));
  return c.json({ data: targets });
});

// PUT /api/links/:id/targets - replace all targeting rules
linkRoutes.put("/:id/targets", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const link = await db.select().from(links).where(eq(links.id, id)).get();
  if (!link || link.userId !== user.id) throw notFound("Link not found");

  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > 10_000) {
    throw new HTTPException(413, { message: "Request body too large" });
  }

  let body: { targets: { type: string; matchValue: string; destinationUrl: string; priority?: number }[] };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!Array.isArray(body.targets)) {
    throw badRequest("targets must be an array");
  }

  // Validate each target
  const VALID_DEVICE_TYPES = new Set(["mobile", "tablet", "desktop"]);
  for (const t of body.targets) {
    if (t.type !== "geo" && t.type !== "device") {
      throw badRequest('Invalid target type. Must be "geo" or "device"');
    }
    if (!t.matchValue || typeof t.matchValue !== "string") {
      throw badRequest("matchValue is required");
    }
    if (t.type === "geo") {
      const code = t.matchValue.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) {
        throw badRequest("Geo matchValue must be a 2-letter ISO country code (e.g. US, GB)");
      }
      t.matchValue = code;
    }
    if (t.type === "device") {
      const device = t.matchValue.trim().toLowerCase();
      if (!VALID_DEVICE_TYPES.has(device)) {
        throw badRequest('Device matchValue must be "mobile", "tablet", or "desktop"');
      }
      t.matchValue = device;
    }
    validateDestinationUrl(t.destinationUrl);
  }

  // Replace all targets atomically via db.batch()
  const newTargets: CachedTarget[] = [];
  const batchOps: any[] = [
    db.delete(linkTargets).where(eq(linkTargets.linkId, id)),
  ];
  for (const t of body.targets) {
    const targetId = crypto.randomUUID();
    const priority = typeof t.priority === "number" ? Math.floor(t.priority) : 0;
    batchOps.push(
      db.insert(linkTargets).values({
        id: targetId,
        linkId: id,
        type: t.type,
        matchValue: t.matchValue,
        destinationUrl: t.destinationUrl,
        priority,
      })
    );
    newTargets.push({
      type: t.type as "geo" | "device",
      matchValue: t.matchValue,
      destinationUrl: t.destinationUrl,
      priority,
    });
  }
  await db.batch(batchOps as [any, ...any[]]);

  // Update KV cache with new targets
  const kvData = await buildCachedRedirect(db, link as any, newTargets.length > 0 ? newTargets : null);
  await setCachedRedirect(c.env.KV, link.slug, kvData);

  // Fetch the inserted targets to return with IDs
  const insertedTargets = await db.select().from(linkTargets).where(eq(linkTargets.linkId, id));
  return c.json({ data: insertedTargets });
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
