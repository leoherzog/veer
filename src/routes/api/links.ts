import { Hono, type Context, type MiddlewareHandler } from "hono";
import { eq, desc, asc, sql, and, or, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../db";
import { links, linkStats, linkTargets, linkCampaigns, campaigns, teamMembers, teams, user as userTable } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, deleteCachedRedirect, toCachedRedirect } from "../../services/kv-cache";
import { badRequest, notFound, conflict } from "../../lib/errors";
import { requireTeamMember } from "../../lib/team";
import { validateHttpUrl, validateDomainAccess } from "../../lib/validators";
import { parseJsonBody, parsePagination, stripPassword } from "../../lib/request";
import { hashPassword, verifyPassword } from "../../services/password";
import { checkRateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types";
import type { CachedRedirect, CachedRedirectSource, CachedTarget } from "../../services/kv-cache";
import type { Database } from "../../db";

/** Build a CachedRedirect object from link data + optional targets. */
async function buildCachedRedirect(
  db: Database,
  link: CachedRedirectSource,
  preloadedTargets?: CachedTarget[] | null,
): Promise<CachedRedirect> {
  let targets: CachedTarget[] | null;
  if (preloadedTargets !== undefined) {
    targets = preloadedTargets;
  } else {
    const rows = await db.select().from(linkTargets).where(eq(linkTargets.linkId, link.id));
    targets = rows.length > 0
      ? rows.map(t => ({ type: t.type as "geo" | "device" | "ab", matchValue: t.matchValue, destinationUrl: t.destinationUrl, priority: t.priority }))
      : null;
  }

  return toCachedRedirect(link, targets);
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

/** Strip the password hash from a link record, replacing with hasPassword boolean. */
/** Check whether a user can access a link: either they own it, or they're a member of the link's team. */
async function canAccessLink(db: Database, link: { userId: string; teamId: string | null }, userId: string): Promise<boolean> {
  if (link.userId === userId) return true;
  if (!link.teamId) return false;
  const member = await db.select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, link.teamId), eq(teamMembers.userId, userId)))
    .get();
  return !!member;
}

type Link = typeof links.$inferSelect;

type LinkEnv = AppEnv & {
  Variables: AppEnv["Variables"] & { link: Link };
};

const linkRoutes = new Hono<LinkEnv>();

/** Load the link by :id, enforce access, and stash the full row on c.var.link. */
const loadLink: MiddlewareHandler<LinkEnv> = async (c, next) => {
  if (c.var.link) return next();
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id")!;
  const link = await db.select().from(links).where(eq(links.id, id)).get();
  if (!link || !(await canAccessLink(db, link, user.id))) throw notFound("Link not found");
  c.set("link", link);
  return next();
};

linkRoutes.use("/:id/*", loadLink);
linkRoutes.use("/:id", loadLink);

// List user's links (or team links if teamId query param provided)
linkRoutes.get("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePagination(c);
  const q = c.req.query("q")?.trim();
  const teamId = c.req.query("teamId")?.trim() || null;
  const scope = c.req.query("scope")?.trim() || null;

  // If teamId provided, validate membership
  if (teamId) {
    await requireTeamMember(db, teamId, user.id);
  }

  const sortParam = c.req.query("sort");
  const dirParam = c.req.query("dir");
  const SORTABLE_COLUMNS = { slug: links.slug, createdAt: links.createdAt, title: links.title, destinationUrl: links.destinationUrl } as const;
  const sortCol = SORTABLE_COLUMNS[sortParam as keyof typeof SORTABLE_COLUMNS] ?? links.createdAt;
  const sortDir = dirParam === "asc" ? asc : desc;

  const escaped = q ? q.replace(/%/g, "\\%").replace(/_/g, "\\_") : "";

  // Build owner filter based on teamId or scope
  let ownerFilter;
  if (teamId) {
    ownerFilter = eq(links.teamId, teamId);
  } else if (scope === "all") {
    // Fetch user's team IDs
    const userTeams = await db.select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, user.id));
    const teamIds = userTeams.map(t => t.teamId);
    if (teamIds.length > 0) {
      ownerFilter = or(eq(links.userId, user.id), inArray(links.teamId, teamIds))!;
    } else {
      ownerFilter = eq(links.userId, user.id);
    }
  } else {
    ownerFilter = eq(links.userId, user.id);
  }

  const pattern = `%${escaped}%`;
  const where = q
    ? and(
        ownerFilter,
        or(
          sql`${links.slug} LIKE ${pattern} ESCAPE '\\'`,
          sql`${links.title} LIKE ${pattern} ESCAPE '\\'`,
          sql`${links.destinationUrl} LIKE ${pattern} ESCAPE '\\'`
        )
      )
    : ownerFilter;

  const [items, countResult] = await Promise.all([
    db.select({ links, teamName: teams.name })
      .from(links)
      .leftJoin(teams, eq(links.teamId, teams.id))
      .where(where)
      .orderBy(sortDir(sortCol))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(links).where(where),
  ]);

  return c.json({
    data: items.map(row => ({ ...stripPassword(row.links), teamName: row.teamName ?? null })),
    pagination: {
      page,
      limit,
      total: countResult[0]?.count ?? 0,
    },
  });
});

// Create link
linkRoutes.post("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{
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
    teamId?: string | null;
  }>(c);

  validateHttpUrl(body.destinationUrl, "destinationUrl");

  // Validate team membership if teamId provided
  if (body.teamId) {
    await requireTeamMember(db, body.teamId, user.id);
  }

  // Enforce maxLinks quota (soft cap — concurrent requests may slightly exceed the limit.
  // D1 does not support SELECT...FOR UPDATE, so this is check-then-act without a transaction.)
  // Note: team-scoped links count against the creator's personal quota intentionally,
  // since the creator (userId) owns the link regardless of team association.
  const userRow = await db.select({ maxLinks: userTable.maxLinks }).from(userTable).where(eq(userTable.id, user.id)).get();
  if (userRow?.maxLinks != null) {
    const [linkCountResult] = await db.select({ count: sql<number>`count(*)` }).from(links).where(eq(links.userId, user.id));
    if ((linkCountResult?.count ?? 0) >= userRow.maxLinks) {
      throw badRequest(`You have reached your link limit (${userRow.maxLinks})`);
    }
  }

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
    validateHttpUrl(body.ogImage, "ogImage");
    ogImage = body.ogImage;
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

  const teamId = body.teamId || null;

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
      teamId,
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
      teamId,
      createdAt: now,
      updatedAt: now,
      isActive: true,
    },
  }, 201);
});

// Get link by ID (with total clicks)
linkRoutes.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const link = c.var.link;

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
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const existing = c.var.link;

  const body = await parseJsonBody<{
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
  }>(c);

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
    validateHttpUrl(body.destinationUrl, "destinationUrl");
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
    if (body.ogImage !== null && body.ogImage !== "") {
      validateHttpUrl(body.ogImage, "ogImage");
    }
    updates.ogImage = (body.ogImage === null || body.ogImage === "") ? null : body.ogImage;
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
  const kvData = await buildCachedRedirect(db, merged);
  await setCachedRedirect(c.env.KV, existing.slug, kvData, merged.domainHostname);

  // Build response — strip password hash
  const response = stripPassword(merged as typeof existing);
  return c.json({ data: response });
});

// Toggle isActive
linkRoutes.patch("/:id/active", async (c) => {
  const db = getDb(c.env.DB);
  const { id } = c.req.param();
  const link = c.var.link;

  // Toggle: if body has explicit isActive use it, otherwise flip current value
  let isActive: boolean;
  try {
    const body = await parseJsonBody<{ isActive?: unknown }>(c);
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
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const link = c.var.link;

  await db.delete(links).where(eq(links.id, id));
  await deleteCachedRedirect(c.env.KV, link.slug, link.domainHostname);

  return c.json({ success: true });
});

// GET /api/links/:id/targets - list targeting rules
linkRoutes.get("/:id/targets", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const targets = await db.select().from(linkTargets).where(eq(linkTargets.linkId, id));
  return c.json({ data: targets });
});

// PUT /api/links/:id/targets - replace all targeting rules
linkRoutes.put("/:id/targets", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const link = c.var.link;

  const body = await parseJsonBody<{ targets: { type: string; matchValue: string; destinationUrl: string; priority?: number }[] }>(c);

  if (!Array.isArray(body.targets)) {
    throw badRequest("targets must be an array");
  }

  // Validate each target
  const VALID_DEVICE_TYPES = new Set(["mobile", "tablet", "desktop"]);
  for (const t of body.targets) {
    if (t.type !== "geo" && t.type !== "device" && t.type !== "ab") {
      throw badRequest('Invalid target type. Must be "geo", "device", or "ab"');
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
    if (t.type === "ab") {
      const weight = parseInt(t.matchValue, 10);
      if (isNaN(weight) || weight < 1 || weight > 99) {
        throw badRequest("A/B weight must be an integer between 1 and 99");
      }
      t.matchValue = String(weight);
    }
    validateHttpUrl(t.destinationUrl, "destinationUrl");
  }

  // Validate A/B weight sum
  const abWeightSum = body.targets
    .filter(t => t.type === "ab")
    .reduce((sum, t) => sum + parseInt(t.matchValue, 10), 0);
  if (abWeightSum >= 100) {
    throw badRequest("A/B variant weights must sum to less than 100");
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
      type: t.type as "geo" | "device" | "ab",
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
  const rl = await checkRateLimit(c.env.KV, rlKey, 5, 900);
  if (rl.exceeded) {
    return c.json({ error: "Too many attempts, try again later" }, 429);
  }
  c.executionCtx.waitUntil(c.env.KV.put(rlKey, String(rl.count + 1), rl.stored === null ? { expirationTtl: 1800 } : {}));

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
