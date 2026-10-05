import { Hono, type MiddlewareHandler } from "hono";
import { eq, desc, asc, and, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { links, linkTargets, linkCampaigns, campaigns, teams } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, deleteCachedRedirect, toCachedRedirect, loadCachedRedirect } from "../../services/kv-cache";
import { badRequest, conflict, isUniqueViolation } from "../../lib/errors";
import { requireTeamMember } from "../../lib/team";
import { accessibleLinks, requireAccessibleLink } from "../../lib/link-access";
import {
  validateHttpUrl, parseOptionalHttpUrl, parseExpiresAt, validateDomainAccess, getPrimaryHostname,
  resolveDomainHostname, assertInternalAllowed, assertLinkQuota,
} from "../../lib/validators";
import { parseJsonBody, parseOptionalJsonBody, parsePagination, searchFilter, stripPassword } from "../../lib/request";
import { hashPassword } from "../../services/password";
import { sumClicks } from "../../services/analytics";
import type { AppEnv } from "../../types";
import type { Database } from "../../db";

function parseMaxClicks(value: number): number {
  const mc = Math.floor(value);
  if (!Number.isFinite(mc) || mc < 1) throw badRequest("maxClicks must be a positive integer");
  return mc;
}

/** Targeting priority: an integer within a range SQLite stores exactly. NaN/Infinity fall back to 0. */
function parsePriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1000, Math.max(-1000, Math.trunc(value)));
}

/** Hash a password field, rejecting non-string values. Empty/null means "no password". */
async function parsePassword(value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest("password must be a string");
  return hashPassword(value);
}

/**
 * Normalize a campaign id list and reject any id the user does not own.
 * Runs before the link write so a bad id cannot leave D1 and KV out of step.
 */
async function validateCampaignIds(db: Database, raw: unknown, userId: string): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest("campaignIds must be an array");
  if (raw.some(id => typeof id !== "string")) throw badRequest("campaignIds must contain strings");
  const ids = [...new Set(raw as string[])];
  if (ids.length === 0) return [];
  const owned = await db.select({ id: campaigns.id }).from(campaigns)
    .where(and(inArray(campaigns.id, ids), eq(campaigns.userId, userId)));
  if (owned.length !== ids.length) throw badRequest("Campaign not found or does not belong to you");
  return ids;
}

/** Map a UNIQUE constraint violation on links(slug, domainHostname) to a 409. */
function rethrowAsSlugConflict(e: unknown): never {
  if (isUniqueViolation(e)) throw conflict("Slug already taken");
  throw e;
}

type Link = typeof links.$inferSelect;

type LinkEnv = AppEnv & {
  Variables: AppEnv["Variables"] & { link: Link };
};

const linkRoutes = new Hono<LinkEnv>();

/** Load the link by :id, enforce access, and stash the full row on c.var.link. */
const loadLink: MiddlewareHandler<LinkEnv> = async (c, next) => {
  c.set("link", await requireAccessibleLink(getDb(c.env.DB), c.req.param("id")!, c.var.user!.id));
  return next();
};

// In Hono `/:id/*` also matches `/:id`, so one registration covers both.
linkRoutes.use("/:id/*", loadLink);

linkRoutes.get("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePagination(c);
  const q = c.req.query("q")?.trim();
  const teamId = c.req.query("teamId")?.trim() || null;
  const scope = c.req.query("scope")?.trim() || null;

  if (teamId) {
    await requireTeamMember(db, teamId, user.id);
  }

  const sortParam = c.req.query("sort");
  const dirParam = c.req.query("dir");
  const SORTABLE_COLUMNS = { slug: links.slug, createdAt: links.createdAt, title: links.title, destinationUrl: links.destinationUrl } as const;
  const sortCol = SORTABLE_COLUMNS[sortParam as keyof typeof SORTABLE_COLUMNS] ?? links.createdAt;
  const sortDir = dirParam === "asc" ? asc : desc;

  let ownerFilter;
  if (teamId) {
    ownerFilter = eq(links.teamId, teamId);
  } else if (scope === "all") {
    ownerFilter = accessibleLinks(user.id);
  } else {
    ownerFilter = eq(links.userId, user.id);
  }

  const where = and(ownerFilter, searchFilter(q, links.slug, links.title, links.destinationUrl));

  const [items, total] = await Promise.all([
    db.select({ links, teamName: teams.name })
      .from(links)
      .leftJoin(teams, eq(links.teamId, teams.id))
      .where(where)
      .orderBy(sortDir(sortCol))
      .limit(limit)
      .offset(offset),
    db.$count(links, where),
  ]);

  return c.json({
    data: items.map(row => ({ ...stripPassword(row.links), teamName: row.teamName ?? null })),
    pagination: { page, limit, total },
  });
});

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
    campaignIds?: string[];
    domainHostname?: string | null;
    teamId?: string | null;
  }>(c);

  validateHttpUrl(body.destinationUrl, "destinationUrl");

  if (body.teamId) {
    await requireTeamMember(db, body.teamId, user.id);
  }

  const primaryHost = getPrimaryHostname(c.env.BETTER_AUTH_URL);
  const domainHostname = resolveDomainHostname(body.domainHostname, primaryHost);

  const isInternal = body.isInternal === true;
  assertInternalAllowed(isInternal, domainHostname);

  if (domainHostname) {
    await validateDomainAccess(db, domainHostname, user.email, user.isAdmin);
  }

  await assertLinkQuota(db, user.id, 1);

  const slugCheck = validateSlug(body.slug);
  if (!slugCheck.valid) throw badRequest(slugCheck.error);
  // Store the canonical form; every lookup normalizes the same way.
  const slug = slugCheck.slug;

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

  const passwordHash = await parsePassword(body.password);

  const paramForwarding = body.paramForwarding === true;

  const ogTitle = body.ogTitle || null;
  const ogDescription = body.ogDescription || null;
  const ogImage = parseOptionalHttpUrl(body.ogImage, "ogImage");

  const createCampaignIds = await validateCampaignIds(db, body.campaignIds, user.id);

  const id = crypto.randomUUID();
  const now = new Date();

  // Both uniqueness indexes (composite + partial) raise a UNIQUE constraint error,
  // so this catch is the only slug-collision check needed.
  const row = await db.insert(links).values({
    id,
    userId: user.id,
    slug,
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
    domainHostname,
    teamId: body.teamId || null,
    createdAt: now,
    updatedAt: now,
  }).returning().get().catch(rethrowAsSlugConflict);

  // Deferred, unlike the awaited update paths: a new slug has no cache entry to go
  // stale, so a lost write costs one D1 read on the first redirect, while an awaited
  // KV failure would 500 a create whose row already committed.
  c.executionCtx.waitUntil(setCachedRedirect(c.env.KV, slug, toCachedRedirect(row, null), domainHostname));

  if (createCampaignIds.length > 0) {
    await db.insert(linkCampaigns).values(createCampaignIds.map(cid => ({ linkId: id, campaignId: cid })))
      .onConflictDoNothing();
  }

  return c.json({ data: stripPassword(row) }, 201);
});

linkRoutes.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const link = c.var.link;

  const [totalClicks, targets, linkedCampaigns] = await Promise.all([
    sumClicks(db, id),
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
      totalClicks,
      targets,
      campaigns: linkedCampaigns,
    },
  });
});

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
    campaignIds?: string[];
    domainHostname?: string | null;
  }>(c);

  const updates: Partial<typeof links.$inferInsert> = { updatedAt: new Date() };
  const primaryHost = getPrimaryHostname(c.env.BETTER_AUTH_URL);
  let domainHostname = existing.domainHostname;

  if (body.domainHostname !== undefined) {
    domainHostname = resolveDomainHostname(body.domainHostname, primaryHost);
    if (domainHostname) {
      await validateDomainAccess(db, domainHostname, user.email, user.isAdmin);
    }
    updates.domainHostname = domainHostname;
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
    updates.password = await parsePassword(body.password);
  }

  if (body.isInternal !== undefined) {
    updates.isInternal = body.isInternal === true;
  }
  assertInternalAllowed(updates.isInternal ?? !!existing.isInternal, domainHostname);

  if (body.ogTitle !== undefined) {
    updates.ogTitle = body.ogTitle || null;
  }
  if (body.ogDescription !== undefined) {
    updates.ogDescription = body.ogDescription || null;
  }
  if (body.ogImage !== undefined) {
    updates.ogImage = parseOptionalHttpUrl(body.ogImage, "ogImage");
  }

  if (body.paramForwarding !== undefined) {
    updates.paramForwarding = body.paramForwarding === true;
  }

  // Campaign associations are validated before any write: a rejection after the D1
  // update would leave the row changed and the KV entry stale for up to the cache TTL.
  const replaceCampaigns = body.campaignIds !== undefined;
  const updateCampaignIds = replaceCampaigns ? await validateCampaignIds(db, body.campaignIds, user.id) : [];

  // The unique indexes reject a domain move onto a taken slug, before any other write.
  await db.update(links).set(updates).where(eq(links.id, id)).catch(rethrowAsSlugConflict);

  // Delete old domain KV key after D1 commit (if domain changed)
  if (existing.domainHostname !== domainHostname) {
    await deleteCachedRedirect(c.env.KV, existing.slug, existing.domainHostname);
  }

  if (replaceCampaigns) {
    await db.delete(linkCampaigns).where(eq(linkCampaigns.linkId, id));
    if (updateCampaignIds.length > 0) {
      await db.insert(linkCampaigns).values(updateCampaignIds.map(cid => ({ linkId: id, campaignId: cid })));
    }
  }

  const merged = { ...existing, ...updates };
  const kvData = await loadCachedRedirect(db, merged);
  await setCachedRedirect(c.env.KV, existing.slug, kvData, merged.domainHostname);

  const response = stripPassword(merged as typeof existing);
  return c.json({ data: response });
});

linkRoutes.patch("/:id/active", async (c) => {
  const db = getDb(c.env.DB);
  const { id } = c.req.param();
  const link = c.var.link;

  // An absent body (or an absent isActive) flips the current value; an explicit value wins.
  const body = await parseOptionalJsonBody<{ isActive?: unknown }>(c);
  const requested = body?.isActive;
  let isActive: boolean;
  if (requested === undefined || requested === null) {
    isActive = !link.isActive;
  } else if (typeof requested === "boolean") {
    isActive = requested;
  } else if (requested === "true" || requested === 1) {
    isActive = true;
  } else if (requested === "false" || requested === 0) {
    isActive = false;
  } else {
    throw badRequest("isActive must be a boolean");
  }

  await db.update(links).set({ isActive, updatedAt: new Date() }).where(eq(links.id, id));

  // Invalidate KV cache when deactivating, re-populate when activating
  if (!isActive) {
    await deleteCachedRedirect(c.env.KV, link.slug, link.domainHostname);
  } else {
    const kvData = await loadCachedRedirect(db, { ...link, isActive: true });
    await setCachedRedirect(c.env.KV, link.slug, kvData, link.domainHostname);
  }

  return c.json({ success: true, isActive });
});

linkRoutes.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const link = c.var.link;

  await db.delete(links).where(eq(links.id, id));
  await deleteCachedRedirect(c.env.KV, link.slug, link.domainHostname);

  return c.json({ success: true });
});

linkRoutes.put("/:id/targets", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const link = c.var.link;

  const body = await parseJsonBody<{
    targets: { type: "geo" | "device" | "ab"; matchValue: string; destinationUrl: string; priority?: number }[];
  }>(c);

  if (!Array.isArray(body.targets)) {
    throw badRequest("targets must be an array");
  }

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

  const abWeightSum = body.targets
    .filter(t => t.type === "ab")
    .reduce((sum, t) => sum + parseInt(t.matchValue, 10), 0);
  if (abWeightSum >= 100) {
    throw badRequest("A/B variant weights must sum to less than 100");
  }

  const rows = body.targets.map(t => ({
    id: crypto.randomUUID(),
    linkId: id,
    type: t.type,
    matchValue: t.matchValue,
    destinationUrl: t.destinationUrl,
    priority: parsePriority(t.priority),
  }));

  // Replace all targets atomically. One insert per row: D1 caps a statement at
  // 100 bound parameters, so a multi-row insert fails past 16 targets.
  await db.batch([
    db.delete(linkTargets).where(eq(linkTargets.linkId, id)),
    db.update(links).set({ updatedAt: new Date() }).where(eq(links.id, id)),
    ...rows.map(row => db.insert(linkTargets).values(row)),
  ]);

  const targets = rows.map(({ type, matchValue, destinationUrl, priority }) => ({ type, matchValue, destinationUrl, priority }));
  await setCachedRedirect(c.env.KV, link.slug, toCachedRedirect(link, targets.length ? targets : null), link.domainHostname);

  return c.json({ data: rows });
});

export default linkRoutes;
