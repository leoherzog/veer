import { Hono, type MiddlewareHandler } from "hono";
import { eq, sql, and, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { campaigns, linkCampaigns, links, linkStats } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseDays, parseJsonBody } from "../../lib/request";
import { statsCutoff } from "../../lib/date";
import { accessibleLinks } from "../../lib/link-access";
import { parseDescription, parseName } from "../../lib/validators";
import { CAMPAIGN_LINKS_MAX } from "../../lib/limits";
import type { AuthedEnv } from "../../types";

type Campaign = typeof campaigns.$inferSelect;

type CampaignEnv = AuthedEnv & {
  Variables: AuthedEnv["Variables"] & { campaign: Campaign };
};

const campaignRoutes = new Hono<CampaignEnv>();

/** Load the caller's campaign by :id, or 404 whether it is missing or someone else's. */
const loadCampaign: MiddlewareHandler<CampaignEnv> = async (c, next) => {
  const campaign = await getDb(c.env.DB).select().from(campaigns)
    .where(and(eq(campaigns.id, c.req.param("id")!), eq(campaigns.userId, c.var.user.id)))
    .get();
  if (!campaign) throw notFound("Campaign not found");
  c.set("campaign", campaign);
  return next();
};

// In Hono `/:id/*` also matches `/:id`, so one registration covers both.
campaignRoutes.use("/:id/*", loadCampaign);

campaignRoutes.get("/", async (c) => {
  const user = c.var.user;
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
  const user = c.var.user;
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{ name?: unknown; description?: unknown }>(c);
  const name = parseName(body.name);
  const description = parseDescription(body.description);
  const now = new Date();

  const campaign = await db.insert(campaigns).values({
    id: crypto.randomUUID(),
    userId: user.id,
    name,
    description,
    createdAt: now,
    updatedAt: now,
  }).returning().get();

  return c.json({ data: campaign }, 201);
});

campaignRoutes.get("/:id", async (c) => {
  const user = c.var.user;
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

  const body = await parseJsonBody<{ name?: unknown; description?: unknown }>(c);

  const updates: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    updates.name = parseName(body.name);
  }

  if (body.description !== undefined) {
    updates.description = parseDescription(body.description);
  }

  const campaign = await db.update(campaigns).set(updates).where(eq(campaigns.id, id)).returning().get();
  return c.json({ data: campaign });
});

campaignRoutes.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await db.delete(campaigns).where(eq(campaigns.id, id));

  return c.json({ success: true });
});

campaignRoutes.post("/:id/links", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const body = await parseJsonBody<{ linkIds?: unknown }>(c);

  if (!Array.isArray(body.linkIds) || body.linkIds.length === 0) {
    throw badRequest("linkIds must be a non-empty array");
  }
  if (body.linkIds.length > CAMPAIGN_LINKS_MAX) {
    throw badRequest(`linkIds must contain ${CAMPAIGN_LINKS_MAX} or fewer items`);
  }
  if (body.linkIds.some(linkId => typeof linkId !== "string")) {
    throw badRequest("linkIds must contain strings");
  }
  const linkIds = body.linkIds as string[];

  // Any link the caller can access, matching what PUT /api/links/:id accepts for campaignIds
  const allowedLinks = await db.select({ id: links.id })
    .from(links)
    .where(and(accessibleLinks(user.id), inArray(links.id, linkIds)));

  const validIds = new Set(allowedLinks.map(l => l.id));
  const invalidIds = linkIds.filter(linkId => !validIds.has(linkId));
  if (invalidIds.length > 0) {
    throw badRequest(`Links not found: ${invalidIds.join(", ")}`);
  }

  // One row per statement keeps each insert's bound parameters small; the batch is atomic.
  const inserts = [...validIds].map(linkId =>
    db.insert(linkCampaigns).values({ linkId, campaignId: id }).onConflictDoNothing());
  await db.batch(inserts as [typeof inserts[number], ...typeof inserts[number][]]);

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
  const user = c.var.user;
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const days = parseDays(c.req.query("days"));

  // Only links the caller can still access count toward the campaign's totals. An
  // aggregate without GROUP BY always returns one row.
  const [totals] = await db
    .select({
      totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)`,
      linkCount: sql<number>`count(distinct ${links.id})`,
    })
    .from(linkCampaigns)
    .innerJoin(links, eq(linkCampaigns.linkId, links.id))
    .leftJoin(linkStats, and(eq(linkStats.linkId, links.id), gte(linkStats.date, statsCutoff(days))))
    .where(and(eq(linkCampaigns.campaignId, id), accessibleLinks(user.id)));

  return c.json({
    data: {
      totalClicks: totals.totalClicks,
      linkCount: totals.linkCount,
      period: { days },
    },
  });
});

export default campaignRoutes;
