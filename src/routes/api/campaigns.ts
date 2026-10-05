import { Hono, type MiddlewareHandler } from "hono";
import { eq, sql, and, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { campaigns, linkCampaigns, links, linkStats } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseDays, parseJsonBody } from "../../lib/request";
import { statsCutoff } from "../../lib/date";
import { accessibleLinks } from "../../lib/link-access";
import { parseName } from "../../lib/validators";
import type { AppEnv } from "../../types";

type Campaign = typeof campaigns.$inferSelect;

type CampaignEnv = AppEnv & {
  Variables: AppEnv["Variables"] & { campaign: Campaign };
};

const campaignRoutes = new Hono<CampaignEnv>();

/** Campaign descriptions are optional text capped at 2000 characters. */
function validateDescription(description: unknown): void {
  if (description === undefined || description === null || description === "") return;
  if (typeof description !== "string") throw badRequest("description must be a string");
  if (description.trim().length > 2000) throw badRequest("description must be 2000 characters or fewer");
}

const loadCampaign: MiddlewareHandler<CampaignEnv> = async (c, next) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id")!;
  const campaign = await db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!campaign || campaign.userId !== user.id) throw notFound("Campaign not found");
  c.set("campaign", campaign);
  return next();
}

// In Hono `/:id/*` also matches `/:id`, so one registration covers both.
campaignRoutes.use("/:id/*", loadCampaign);

campaignRoutes.get("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);

  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      description: campaigns.description,
      createdAt: campaigns.createdAt,
      updatedAt: campaigns.updatedAt,
      linkCount: sql<number>`count(${links.id})`,
    })
    .from(campaigns)
    .leftJoin(linkCampaigns, eq(campaigns.id, linkCampaigns.campaignId))
    // An association outlives the caller's access to the link, so the join drops
    // inaccessible ones — the count must match what GET /:id and /:id/stats report.
    .leftJoin(links, and(eq(linkCampaigns.linkId, links.id), accessibleLinks(user.id)))
    .where(eq(campaigns.userId, user.id))
    .groupBy(campaigns.id)
    .orderBy(campaigns.createdAt);

  return c.json({ data: rows });
});

campaignRoutes.post("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{ name: string; description?: string }>(c);

  const name = parseName(body.name);
  validateDescription(body.description);

  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(campaigns).values({
    id,
    userId: user.id,
    name,
    description: body.description?.trim() || null,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({
    data: {
      id,
      userId: user.id,
      name,
      description: body.description?.trim() || null,
      createdAt: now,
      updatedAt: now,
    },
  }, 201);
});

campaignRoutes.get("/:id", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const campaign = c.var.campaign;

  // Fetch linked links with per-link click totals. An association outlives the caller's
  // access to the link (team membership can be revoked), so filter on access here.
  const linkedRows = await db
    .select({
      id: links.id,
      slug: links.slug,
      destinationUrl: links.destinationUrl,
      title: links.title,
      createdAt: links.createdAt,
      isActive: links.isActive,
      domainHostname: links.domainHostname,
      totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)`,
    })
    .from(linkCampaigns)
    .innerJoin(links, eq(linkCampaigns.linkId, links.id))
    .leftJoin(linkStats, eq(links.id, linkStats.linkId))
    .where(and(eq(linkCampaigns.campaignId, id), accessibleLinks(user.id)))
    .groupBy(links.id);

  return c.json({ data: { ...campaign, links: linkedRows } });
});

campaignRoutes.put("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const existing = c.var.campaign;

  const body = await parseJsonBody<{ name?: string; description?: string | null }>(c);

  const updates: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    updates.name = parseName(body.name);
  }

  if (body.description !== undefined) {
    validateDescription(body.description);
    updates.description = body.description?.trim() || null;
  }

  await db.update(campaigns).set(updates).where(eq(campaigns.id, id));

  const merged = { ...existing, ...updates };
  return c.json({ data: merged });
});

campaignRoutes.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await db.delete(campaigns).where(eq(campaigns.id, id));

  return c.json({ success: true });
});

campaignRoutes.post("/:id/links", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const body = await parseJsonBody<{ linkIds: string[] }>(c);

  if (!Array.isArray(body.linkIds) || body.linkIds.length === 0) {
    throw badRequest("linkIds must be a non-empty array");
  }
  if (body.linkIds.length > 100) {
    throw badRequest("linkIds must contain 100 or fewer items");
  }
  if (body.linkIds.some(linkId => typeof linkId !== "string")) {
    throw badRequest("linkIds must contain strings");
  }

  // Any link the caller can access, matching what PUT /api/links/:id accepts for campaignIds
  const allowedLinks = await db.select({ id: links.id })
    .from(links)
    .where(and(accessibleLinks(user.id), inArray(links.id, body.linkIds)));

  const validIds = new Set(allowedLinks.map(l => l.id));
  const invalidIds = body.linkIds.filter(id => !validIds.has(id));
  if (invalidIds.length > 0) {
    throw badRequest(`Links not found: ${invalidIds.join(", ")}`);
  }

  await db.insert(linkCampaigns).values([...validIds].map(linkId => ({ linkId, campaignId: id })))
    .onConflictDoNothing();

  return c.json({ success: true });
});

campaignRoutes.delete("/:id/links/:linkId", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const linkId = c.req.param("linkId");

  await db.delete(linkCampaigns)
    .where(and(eq(linkCampaigns.campaignId, id), eq(linkCampaigns.linkId, linkId)));

  return c.json({ success: true });
});

campaignRoutes.get("/:id/stats", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const days = parseDays(c.req.query("days"));

  // Only links the caller can still access count toward the campaign's totals.
  const totals = await db
    .select({
      totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)`,
      linkCount: sql<number>`count(distinct ${links.id})`,
    })
    .from(linkCampaigns)
    .innerJoin(links, eq(linkCampaigns.linkId, links.id))
    .leftJoin(linkStats, and(eq(linkStats.linkId, links.id), gte(linkStats.date, statsCutoff(days))))
    .where(and(eq(linkCampaigns.campaignId, id), accessibleLinks(user.id)))
    .get();

  return c.json({
    data: {
      totalClicks: totals?.totalClicks ?? 0,
      linkCount: totals?.linkCount ?? 0,
      period: { days },
    },
  });
});

export default campaignRoutes;
