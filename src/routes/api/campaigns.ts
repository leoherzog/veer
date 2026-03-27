import { Hono, type MiddlewareHandler } from "hono";
import { eq, sql, and, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { campaigns, linkCampaigns, links, linkStats } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import type { AppEnv } from "../../types";

type Campaign = typeof campaigns.$inferSelect;

type CampaignEnv = AppEnv & {
  Variables: AppEnv["Variables"] & { campaign: Campaign };
};

const campaignRoutes = new Hono<CampaignEnv>();

const loadCampaign: MiddlewareHandler<CampaignEnv> = async (c, next) => {
  if (c.var.campaign) return next();
  const user = c.var.user!;
  const db = getDb(c.env.DB);
  const id = c.req.param("id")!;
  const campaign = await db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!campaign || campaign.userId !== user.id) throw notFound("Campaign not found");
  c.set("campaign", campaign);
  return next();
}

campaignRoutes.use("/:id/*", loadCampaign);
campaignRoutes.use("/:id", loadCampaign);

// List user's campaigns (with link count)
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
      linkCount: sql<number>`count(${linkCampaigns.linkId})`,
    })
    .from(campaigns)
    .leftJoin(linkCampaigns, eq(campaigns.id, linkCampaigns.campaignId))
    .where(eq(campaigns.userId, user.id))
    .groupBy(campaigns.id)
    .orderBy(campaigns.createdAt);

  return c.json({ data: rows });
});

// Create campaign
campaignRoutes.post("/", async (c) => {
  const user = c.var.user!;
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{ name: string; description?: string }>(c);

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    throw badRequest("name is required");
  }
  if (body.name.trim().length > 200) {
    throw badRequest("name must be 200 characters or fewer");
  }
  if (body.description && body.description.trim().length > 2000) {
    throw badRequest("description must be 2000 characters or fewer");
  }

  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(campaigns).values({
    id,
    userId: user.id,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({
    data: {
      id,
      userId: user.id,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      createdAt: now,
      updatedAt: now,
    },
  }, 201);
});

// Get campaign details + linked links
campaignRoutes.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const campaign = c.var.campaign;

  // Fetch linked links with per-link click totals
  const linkedRows = await db
    .select({
      id: links.id,
      slug: links.slug,
      destinationUrl: links.destinationUrl,
      title: links.title,
      createdAt: links.createdAt,
      isActive: links.isActive,
      totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)`,
    })
    .from(linkCampaigns)
    .innerJoin(links, eq(linkCampaigns.linkId, links.id))
    .leftJoin(linkStats, eq(links.id, linkStats.linkId))
    .where(eq(linkCampaigns.campaignId, id))
    .groupBy(links.id);

  return c.json({ data: { ...campaign, links: linkedRows } });
});

// Update campaign
campaignRoutes.put("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const existing = c.var.campaign;

  const body = await parseJsonBody<{ name?: string; description?: string | null }>(c);

  const updates: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };

  if (body.name !== undefined) {
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      throw badRequest("name cannot be empty");
    }
    if (body.name.trim().length > 200) {
      throw badRequest("name must be 200 characters or fewer");
    }
    updates.name = body.name.trim();
  }

  if (body.description !== undefined) {
    if (body.description && body.description.trim().length > 2000) {
      throw badRequest("description must be 2000 characters or fewer");
    }
    updates.description = body.description?.trim() || null;
  }

  await db.update(campaigns).set(updates).where(eq(campaigns.id, id));

  const merged = { ...existing, ...updates };
  return c.json({ data: merged });
});

// Delete campaign
campaignRoutes.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  await db.delete(campaigns).where(eq(campaigns.id, id));

  return c.json({ success: true });
});

// Add links to campaign
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

  // Verify all links belong to the user
  const userLinks = await db.select({ id: links.id })
    .from(links)
    .where(and(eq(links.userId, user.id), inArray(links.id, body.linkIds)));

  const validIds = new Set(userLinks.map(l => l.id));
  const invalidIds = body.linkIds.filter(id => !validIds.has(id));
  if (invalidIds.length > 0) {
    throw badRequest(`Links not found: ${invalidIds.join(", ")}`);
  }

  // Insert associations in a single batch (ignore duplicates via onConflictDoNothing)
  await db.insert(linkCampaigns).values(body.linkIds.map(linkId => ({ linkId, campaignId: id })))
    .onConflictDoNothing();

  return c.json({ success: true });
});

// Remove link from campaign
campaignRoutes.delete("/:id/links/:linkId", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const linkId = c.req.param("linkId");

  await db.delete(linkCampaigns)
    .where(and(eq(linkCampaigns.campaignId, id), eq(linkCampaigns.linkId, linkId)));

  return c.json({ success: true });
});

// Aggregate stats across all campaign links
campaignRoutes.get("/:id/stats", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");

  const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 30));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Get all link IDs in this campaign
  const campaignLinks = await db.select({ linkId: linkCampaigns.linkId })
    .from(linkCampaigns)
    .where(eq(linkCampaigns.campaignId, id));

  if (campaignLinks.length === 0) {
    return c.json({ data: { totalClicks: 0, linkCount: 0, period: { days } } });
  }

  const linkIds = campaignLinks.map(l => l.linkId);

  const statsResult = await db
    .select({ totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)` })
    .from(linkStats)
    .where(and(
      inArray(linkStats.linkId, linkIds),
      gte(linkStats.date, cutoff),
    ));

  return c.json({
    data: {
      totalClicks: statsResult[0]?.totalClicks ?? 0,
      linkCount: linkIds.length,
      period: { days },
    },
  });
});

export default campaignRoutes;
