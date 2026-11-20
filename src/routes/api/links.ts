import { Hono, type MiddlewareHandler } from "hono";
import { eq, desc, asc, and, inArray, type AnyColumn } from "drizzle-orm";
import { getDb } from "../../db";
import { links, linkTargets, linkCampaigns, campaigns, teams } from "../../db/schema";
import {
  setCachedRedirect, deleteCachedRedirect, toCachedRedirect, loadCachedRedirect, type CachedTarget,
} from "../../services/kv-cache";
import { badRequest, conflict, isUniqueViolation } from "../../lib/errors";
import { requireTeamMember } from "../../lib/team";
import { accessibleLinks, requireAccessibleLink } from "../../lib/link-access";
import {
  validateHttpUrl, parseOptionalHttpUrl, parseOptionalString, parseExpiresAt, parsePositiveInt, parseLinkCore,
  validateDomainAccess, getPrimaryHostname, resolveDomainHostname, assertInternalAllowed, assertLinkQuota,
} from "../../lib/validators";
import { parseJsonBody, parsePagination, searchFilter, stripPassword } from "../../lib/request";
import { CAMPAIGN_LINKS_MAX } from "../../lib/limits";
import { hashPassword } from "../../services/password";
import { DEVICE_TYPES } from "../../services/useragent";
import { sumClicks } from "../../services/analytics";
import type { AuthedEnv } from "../../types";
import type { Database } from "../../db";

const MAX_CLICKS_MESSAGE = "maxClicks must be a positive integer";

/** Columns GET / sorts by. A Map, so `?sort=__proto__` misses instead of reaching Object.prototype. */
const SORTABLE_COLUMNS = new Map<string, AnyColumn>([
  ["slug", links.slug],
  ["createdAt", links.createdAt],
  ["title", links.title],
  ["destinationUrl", links.destinationUrl],
]);

type TargetType = CachedTarget["type"];

const TARGET_TYPES: readonly string[] = linkTargets.type.enumValues;
const DEVICES: readonly string[] = DEVICE_TYPES;

function isTargetType(value: unknown): value is TargetType {
  return typeof value === "string" && TARGET_TYPES.includes(value);
}

/** Targeting priority: an integer within a range SQLite stores exactly. NaN/Infinity fall back to 0. */
function parsePriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1000, Math.max(-1000, Math.trunc(value)));
}

/** Validate one targeting rule and return it normalized, leaving the input untouched. */
function parseTarget(raw: unknown): CachedTarget {
  if (!raw || typeof raw !== "object") throw badRequest("Each target must be an object");
  const t = raw as Record<string, unknown>;

  if (!isTargetType(t.type)) {
    throw badRequest(`Invalid target type. Must be one of: ${TARGET_TYPES.join(", ")}`);
  }
  if (typeof t.matchValue !== "string" || !t.matchValue) throw badRequest("matchValue is required");
  const destinationUrl = typeof t.destinationUrl === "string" ? t.destinationUrl : "";
  validateHttpUrl(destinationUrl, "destinationUrl");

  let matchValue: string;
  switch (t.type) {
    case "geo":
      matchValue = t.matchValue.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(matchValue)) {
        throw badRequest("Geo matchValue must be a 2-letter ISO country code (e.g. US, GB)");
      }
      break;
    case "device":
      matchValue = t.matchValue.trim().toLowerCase();
      if (!DEVICES.includes(matchValue)) {
        throw badRequest(`Device matchValue must be one of: ${DEVICE_TYPES.join(", ")}`);
      }
      break;
    case "ab": {
      const weight = parseInt(t.matchValue, 10);
      if (isNaN(weight) || weight < 1 || weight > 99) {
        throw badRequest("A/B weight must be an integer between 1 and 99");
      }
      matchValue = String(weight);
      break;
    }
  }

  return { type: t.type, matchValue, destinationUrl, priority: parsePriority(t.priority) };
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
  if (raw.length > CAMPAIGN_LINKS_MAX) throw badRequest(`campaignIds must contain ${CAMPAIGN_LINKS_MAX} or fewer items`);
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

type LinkEnv = AuthedEnv & {
  Variables: AuthedEnv["Variables"] & { link: Link };
};

const linkRoutes = new Hono<LinkEnv>();

/** Load the link by :id, enforce access, and stash the full row on c.var.link. */
const loadLink: MiddlewareHandler<LinkEnv> = async (c, next) => {
  c.set("link", await requireAccessibleLink(getDb(c.env.DB), c.req.param("id")!, c.var.user.id));
  return next();
};

// In Hono `/:id/*` also matches `/:id`, so one registration covers both.
linkRoutes.use("/:id/*", loadLink);

linkRoutes.get("/", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const { page, limit, offset } = parsePagination(c);
  const teamId = c.req.query("teamId")?.trim() || null;
  const scope = c.req.query("scope")?.trim() || null;

  if (teamId) {
    await requireTeamMember(db, teamId, user.id);
  }

  const sortCol = SORTABLE_COLUMNS.get(c.req.query("sort") ?? "") ?? links.createdAt;
  const sortDir = c.req.query("dir") === "asc" ? asc : desc;

  let ownerFilter;
  if (teamId) {
    ownerFilter = eq(links.teamId, teamId);
  } else if (scope === "all") {
    ownerFilter = accessibleLinks(user.id);
  } else {
    ownerFilter = eq(links.userId, user.id);
  }

  const where = and(ownerFilter, searchFilter(c.req.query("q"), links.slug, links.title, links.destinationUrl));

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
  const user = c.var.user;

  const body = await parseJsonBody<{
    expiresAt?: string | number;
    maxClicks?: number | null;
    password?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImage?: string;
    paramForwarding?: boolean;
    campaignIds?: string[];
    teamId?: string | null;
  }>(c);

  // The core, expiry, click-cap and OG-image parsers need no D1 and run before
  // the first query. The password is hashed last, once the cheaper checks pass.
  const core = parseLinkCore(body, getPrimaryHostname(c.env.BETTER_AUTH_URL));
  const expiresAt = body.expiresAt != null ? parseExpiresAt(body.expiresAt) : null;
  const maxClicks = body.maxClicks != null ? parsePositiveInt(body.maxClicks, MAX_CLICKS_MESSAGE) : null;
  const ogImage = parseOptionalHttpUrl(body.ogImage, "ogImage");
  const teamId = body.teamId || null;

  const db = getDb(c.env.DB);

  if (teamId) {
    await requireTeamMember(db, teamId, user.id);
  }
  if (core.domainHostname) {
    await validateDomainAccess(db, core.domainHostname, user.email, user.isAdmin);
  }
  await assertLinkQuota(db, user.id, 1);
  const campaignIds = await validateCampaignIds(db, body.campaignIds, user.id);
  const password = await parsePassword(body.password);

  const id = crypto.randomUUID();
  const now = new Date();

  // Both uniqueness indexes (composite + partial) raise a UNIQUE constraint error,
  // so this catch is the only slug-collision check needed. The batch is atomic, so
  // a rejected slug leaves no campaign rows behind.
  const [[row]] = await db.batch([
    db.insert(links).values({
      ...core,
      id,
      userId: user.id,
      expiresAt,
      maxClicks,
      password,
      paramForwarding: body.paramForwarding === true,
      ogTitle: body.ogTitle || null,
      ogDescription: body.ogDescription || null,
      ogImage,
      teamId,
      createdAt: now,
      updatedAt: now,
    }).returning(),
    ...campaignIds.map(campaignId => db.insert(linkCampaigns).values({ linkId: id, campaignId })),
  ]).catch(rethrowAsSlugConflict);

  // Deferred, unlike the awaited update paths: a new slug has no cache entry to go
  // stale, so a lost write costs one D1 read on the first redirect, while an awaited
  // KV failure would 500 a create whose row already committed.
  c.executionCtx.waitUntil(setCachedRedirect(c.env.KV, row.slug, toCachedRedirect(row, null), row.domainHostname));

  return c.json({ data: stripPassword(row) }, 201);
});

linkRoutes.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const link = c.var.link;

  const [totalClicks, targets, linkedCampaigns] = await Promise.all([
    sumClicks(db, id),
    db.select().from(linkTargets).where(eq(linkTargets.linkId, id)),
    // Campaigns are private to their owner, so a teammate's campaign on a shared link stays hidden.
    db.select({
        id: campaigns.id,
        name: campaigns.name,
      })
      .from(linkCampaigns)
      .innerJoin(campaigns, eq(linkCampaigns.campaignId, campaigns.id))
      .where(and(eq(linkCampaigns.linkId, id), eq(campaigns.userId, c.var.user.id))),
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
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const existing = c.var.link;

  const body = await parseJsonBody<{
    destinationUrl?: string;
    redirectType?: number;
    title?: string | null;
    expiresAt?: string | number | null;
    maxClicks?: number | null;
    password?: string | null;
    isInternal?: boolean;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImage?: string | null;
    paramForwarding?: boolean;
    campaignIds?: string[] | null;
    domainHostname?: string | null;
  }>(c);

  const updates: Partial<typeof links.$inferInsert> = { updatedAt: new Date() };
  let domainHostname = existing.domainHostname;

  if (body.domainHostname !== undefined) {
    const requested = resolveDomainHostname(body.domainHostname, getPrimaryHostname(c.env.BETTER_AUTH_URL));
    // Only a move is access-checked, so a teammate without access to a restricted
    // domain can still edit a link that already sits on it.
    if (requested !== domainHostname) {
      if (requested) {
        await validateDomainAccess(db, requested, user.email, user.isAdmin);
      }
      updates.domainHostname = requested;
      domainHostname = requested;
    }
  }

  if (body.destinationUrl !== undefined) {
    validateHttpUrl(body.destinationUrl, "destinationUrl");
    updates.destinationUrl = body.destinationUrl;
  }

  if (body.redirectType !== undefined) {
    updates.redirectType = body.redirectType === 301 ? 301 : 302;
  }

  if (body.title !== undefined) {
    updates.title = parseOptionalString(body.title, "title");
  }

  if (body.expiresAt !== undefined) {
    updates.expiresAt = body.expiresAt === null ? null : parseExpiresAt(body.expiresAt);
  }

  if (body.maxClicks !== undefined) {
    updates.maxClicks = body.maxClicks === null ? null : parsePositiveInt(body.maxClicks, MAX_CLICKS_MESSAGE);
  }

  // Handle password: non-empty string = set, null/empty = clear, absent = unchanged
  if (body.password !== undefined) {
    updates.password = await parsePassword(body.password);
  }

  if (body.isInternal !== undefined) {
    updates.isInternal = body.isInternal === true;
  }
  assertInternalAllowed(updates.isInternal ?? existing.isInternal, domainHostname);

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
  const campaignIds = replaceCampaigns ? await validateCampaignIds(db, body.campaignIds, user.id) : [];

  // One atomic batch. The unique indexes reject a domain move onto a taken slug, and
  // then no association changes either. Only the caller's own campaigns are replaced,
  // so a teammate's campaign on a shared link keeps its association.
  const ownCampaigns = db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.userId, user.id));
  await db.batch([
    db.update(links).set(updates).where(eq(links.id, id)),
    ...(replaceCampaigns ? [
      db.delete(linkCampaigns).where(and(eq(linkCampaigns.linkId, id), inArray(linkCampaigns.campaignId, ownCampaigns))),
      ...campaignIds.map(campaignId => db.insert(linkCampaigns).values({ linkId: id, campaignId })),
    ] : []),
  ]).catch(rethrowAsSlugConflict);

  // Delete old domain KV key after D1 commit (if domain changed)
  if (existing.domainHostname !== domainHostname) {
    await deleteCachedRedirect(c.env.KV, existing.slug, existing.domainHostname);
  }

  const merged = { ...existing, ...updates };
  const kvData = await loadCachedRedirect(db, merged);
  await setCachedRedirect(c.env.KV, existing.slug, kvData, merged.domainHostname);

  const response = stripPassword(merged as typeof existing);
  return c.json({ data: response });
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

  const body = await parseJsonBody<{ targets?: unknown }>(c);

  if (!Array.isArray(body.targets)) {
    throw badRequest("targets must be an array");
  }

  const targets = body.targets.map(parseTarget);

  const abWeightSum = targets
    .filter(t => t.type === "ab")
    .reduce((sum, t) => sum + Number(t.matchValue), 0);
  if (abWeightSum >= 100) {
    throw badRequest("A/B variant weights must sum to less than 100");
  }

  const rows = targets.map(t => ({ id: crypto.randomUUID(), linkId: id, ...t }));

  // Replace all targets atomically. One insert per row: D1 caps a statement at
  // 100 bound parameters, so a multi-row insert fails past 16 targets.
  await db.batch([
    db.delete(linkTargets).where(eq(linkTargets.linkId, id)),
    db.update(links).set({ updatedAt: new Date() }).where(eq(links.id, id)),
    ...rows.map(row => db.insert(linkTargets).values(row)),
  ]);

  await setCachedRedirect(c.env.KV, link.slug, toCachedRedirect(link, targets.length ? targets : null), link.domainHostname);

  return c.json({ data: rows });
});

export default linkRoutes;
