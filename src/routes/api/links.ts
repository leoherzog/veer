import { Hono, type Context } from "hono";
import { eq, desc, asc, sql, and, or, like, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../db";
import { links, linkStats, linkTargets, linkCampaigns, campaigns, domainConfig, domainAccess } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, deleteCachedRedirect } from "../../services/kv-cache";
import { badRequest, notFound, conflict, checkBodySize } from "../../lib/errors";
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
    ogImage: string | null; paramForwarding: boolean | number; domainHostname?: string | null },
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
    domainHostname: link.domainHostname ?? null,
  };
}

/** Validate that a URL is parseable and uses http(s) scheme. */
function validateHttpUrl(url: string, fieldName: string): void {
  if (!url) throw badRequest(`${fieldName} is required`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`Invalid ${fieldName}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest(`${fieldName} must use http or https`);
  }
}

function validateDestinationUrl(url: string): void {
  validateHttpUrl(url, "destinationUrl");
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
  validateHttpUrl(url, "ogImage");
  return url;
}

/** Strip the password hash from a link record, replacing with hasPassword boolean. */
function stripPassword<T extends { password?: string | null }>(link: T): Omit<T, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = link;
  return { ...rest, hasPassword: !!password };
}

/** Validate domain access: checks domain exists in domain_config AND user has access. */
async function validateDomainAccess(db: Database, hostname: string, userEmail: string, isAdmin: boolean): Promise<void> {
  const domain = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!domain) throw badRequest("Domain not found");
  if (isAdmin) return;
  if (domain.accessMode === "all") return;
  // Restricted mode: check domain_access table
  const access = await db.select().from(domainAccess)
    .where(and(eq(domainAccess.hostname, hostname), eq(domainAccess.email, userEmail.toLowerCase())))
    .get();
  if (!access) throw badRequest("You do not have access to this domain");
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

  checkBodySize(c.req.header("content-length"));

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
    campaignIds?: string[];
    domainHostname?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  validateDestinationUrl(body.destinationUrl);

  // Validate domain access if provided
  if (body.domainHostname) {
    await validateDomainAccess(db, body.domainHostname, user.email, user.isAdmin);
  }

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
  const domainHostname = body.domainHostname || null;

  // Check slug uniqueness within the target domain
  // (SQLite UNIQUE index treats NULLs as distinct, so we must check manually)
  const slugWhereClause = domainHostname
    ? and(eq(links.slug, body.slug), eq(links.domainHostname, domainHostname))
    : and(eq(links.slug, body.slug), sql`${links.domainHostname} IS NULL`);
  const existing = await db.select({ id: links.id }).from(links).where(slugWhereClause).get();
  if (existing) throw conflict("Slug already taken");

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
      domainHostname: body.domainHostname || null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e: unknown) {
    if (e instanceof Error && (e.message.includes("UNIQUE constraint") || (e.cause instanceof Error && e.cause.message.includes("UNIQUE constraint")))) {
      throw conflict("Slug already taken");
    }
    throw e;
  }

  // Write-through to KV (domain-scoped key)
  const kvData = await buildCachedRedirect(db, {
    id, destinationUrl: body.destinationUrl, redirectType, isActive: true,
    expiresAt, maxClicks, password: passwordHash, isInternal, ogTitle, ogDescription, ogImage, paramForwarding,
    domainHostname: body.domainHostname || null,
  }, null);
  await setCachedRedirect(c.env.KV, body.slug, kvData, body.domainHostname || null);

  // Handle campaign associations on create
  const createCampaignIds = body.campaignIds?.length ? body.campaignIds : body.campaignId ? [body.campaignId] : [];
  if (createCampaignIds.length > 0) {
    const validCampaigns = await db.select({ id: campaigns.id }).from(campaigns)
      .where(and(inArray(campaigns.id, createCampaignIds), eq(campaigns.userId, user.id)));
    const validIds = new Set(validCampaigns.map(c => c.id));
    const toInsert = createCampaignIds.filter(cid => validIds.has(cid));
    if (toInsert.length > 0) {
      await db.insert(linkCampaigns).values(toInsert.map(cid => ({ linkId: id, campaignId: cid })))
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
      domainHostname: body.domainHostname || null,
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
      domainHostname: link.domainHostname ?? null,
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

  checkBodySize(c.req.header("content-length"));

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
    campaignIds?: string[];
    domainHostname?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const updates: Partial<typeof links.$inferInsert> = { updatedAt: new Date() };

  // Handle domain change
  if (body.domainHostname !== undefined) {
    if (body.domainHostname) {
      await validateDomainAccess(db, body.domainHostname, user.email, user.isAdmin);
    }
    const newDomainHostname = body.domainHostname || null;
    // Check slug uniqueness on target domain (exclude current link)
    if (newDomainHostname !== existing.domainHostname) {
      const slugCheck = newDomainHostname
        ? and(eq(links.slug, existing.slug), eq(links.domainHostname, newDomainHostname), sql`${links.id} != ${id}`)
        : and(eq(links.slug, existing.slug), sql`${links.domainHostname} IS NULL`, sql`${links.id} != ${id}`);
      const conflict_row = await db.select({ id: links.id }).from(links).where(slugCheck).get();
      if (conflict_row) throw conflict("Slug already taken on target domain");
    }
    updates.domainHostname = newDomainHostname;
  }

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

  // Delete old domain KV key after D1 commit (if domain changed)
  if (body.domainHostname !== undefined && existing.domainHostname !== (body.domainHostname || null)) {
    await deleteCachedRedirect(c.env.KV, existing.slug, existing.domainHostname);
  }

  // Handle campaign association update (supports campaignIds array or legacy campaignId)
  const hasCampaignIds = body.campaignIds !== undefined;
  const hasLegacyCampaignId = body.campaignId !== undefined;
  if (hasCampaignIds || hasLegacyCampaignId) {
    const updateCampaignIds = hasCampaignIds
      ? (body.campaignIds || [])
      : body.campaignId ? [body.campaignId] : [];
    // Validate all campaign IDs ownership in a single query
    if (updateCampaignIds.length > 0) {
      const validCampaigns = await db.select({ id: campaigns.id }).from(campaigns)
        .where(and(inArray(campaigns.id, updateCampaignIds), eq(campaigns.userId, user.id)));
      const validIds = new Set(validCampaigns.map(c => c.id));
      const invalid = updateCampaignIds.filter(cid => !validIds.has(cid));
      if (invalid.length > 0) throw badRequest("Campaign not found or does not belong to you");
    }
    // Remove existing campaign associations
    await db.delete(linkCampaigns).where(eq(linkCampaigns.linkId, id));
    // Add new associations in a single insert
    if (updateCampaignIds.length > 0) {
      await db.insert(linkCampaigns).values(updateCampaignIds.map(cid => ({ linkId: id, campaignId: cid })));
    }
  }

  // Build merged record for KV and response
  const merged = { ...existing, ...updates };
  // Determine password for KV (updates may have changed it)
  const mergedPassword = updates.password !== undefined ? (updates.password as string | null) : existing.password;

  const mergedHostname = updates.domainHostname !== undefined ? (updates.domainHostname as string | null) : existing.domainHostname;
  const kvData = await buildCachedRedirect(db, {
    id,
    destinationUrl: (merged.destinationUrl ?? existing.destinationUrl) as string,
    redirectType: (merged.redirectType ?? existing.redirectType) as number,
    isActive: merged.isActive ?? existing.isActive,
    expiresAt: merged.expiresAt !== undefined ? merged.expiresAt : existing.expiresAt,
    maxClicks: merged.maxClicks !== undefined ? (merged.maxClicks ?? null) : existing.maxClicks,
    password: mergedPassword,
    isInternal: merged.isInternal ?? existing.isInternal,
    ogTitle: merged.ogTitle !== undefined ? (merged.ogTitle ?? null) : existing.ogTitle,
    ogDescription: merged.ogDescription !== undefined ? (merged.ogDescription ?? null) : existing.ogDescription,
    ogImage: merged.ogImage !== undefined ? (merged.ogImage ?? null) : existing.ogImage,
    paramForwarding: merged.paramForwarding ?? existing.paramForwarding,
    domainHostname: mergedHostname,
  });
  await setCachedRedirect(c.env.KV, existing.slug, kvData, mergedHostname);

  // Build response — strip password hash
  const response = stripPassword(merged as typeof existing);
  return c.json({ data: response });
});

// Toggle isActive
linkRoutes.patch("/:id/active", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const { id } = c.req.param();

  const link = await db.select().from(links).where(and(eq(links.id, id), eq(links.userId, user.id))).get();
  if (!link) throw notFound("Link not found");

  // Toggle: if body has explicit isActive use it, otherwise flip current value
  let isActive: boolean;
  try {
    const body = await c.req.json<{ isActive?: unknown }>();
    isActive = body.isActive === true || body.isActive === "true" || body.isActive === 1;
  } catch {
    isActive = !link.isActive;
  }

  await db.update(links).set({ isActive, updatedAt: new Date() }).where(eq(links.id, id));

  // Invalidate KV cache when deactivating, re-populate when activating
  if (!isActive) {
    await deleteCachedRedirect(c.env.KV, link.slug, link.domainHostname);
  } else {
    const kvData = await buildCachedRedirect(db, { ...link, isActive: true });
    await setCachedRedirect(c.env.KV, link.slug, kvData, link.domainHostname);
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
  await deleteCachedRedirect(c.env.KV, link.slug, link.domainHostname);

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

  checkBodySize(c.req.header("content-length"));

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
  const batchOps: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
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
  await db.batch(batchOps);

  // Update KV cache with new targets (domain-scoped)
  const kvData = await buildCachedRedirect(db, link, newTargets.length > 0 ? newTargets : null);
  await setCachedRedirect(c.env.KV, link.slug, kvData, link.domainHostname);

  // Fetch the inserted targets to return with IDs
  const insertedTargets = await db.select().from(linkTargets).where(eq(linkTargets.linkId, id));
  return c.json({ data: insertedTargets });
});

/** Public endpoint: verify a link's password via JSON API (no auth required). */
export async function checkPassword(c: Context<AppEnv, "/api/links/:id/check-password">) {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const id = c.req.param("id");
  // Brute-force protection: 5 attempts per 15-minute window per IP+link
  const windowEpoch = Math.floor(Date.now() / 1000 / 900);
  const rlKey = `rl:pw:${id}:${ip}:${windowEpoch}`;
  const stored = await c.env.KV.get(rlKey);
  const rlCount = stored ? parseInt(stored, 10) : 0;
  if (rlCount >= 5) {
    return c.json({ error: "Too many attempts, try again later" }, 429);
  }
  c.executionCtx.waitUntil(c.env.KV.put(rlKey, String(rlCount + 1), stored === null ? { expirationTtl: 1800 } : {}));

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
