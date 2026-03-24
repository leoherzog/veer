import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and, sql, gte } from "drizzle-orm";
import { getDb } from "../../db";
import { publicReports, links, linkStats } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { formatDate } from "../../lib/date";
import type { AppEnv } from "../../types";

/** Generate a report token: `rpt_` + 32 random base62 chars. */
function generateReportToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const limit = 256 - (256 % chars.length);
  const bytes = new Uint8Array(48);
  let token = "rpt_";
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    if (b < limit && token.length < 36) {
      token += chars[b % chars.length];
    }
  }
  // In the unlikely event we didn't get 32 chars, fill the rest
  while (token.length < 36) {
    const extra = new Uint8Array(16);
    crypto.getRandomValues(extra);
    for (const b of extra) {
      if (b < limit && token.length < 36) {
        token += chars[b % chars.length];
      }
    }
  }
  return token;
}

const reportRoutes = new Hono<AppEnv>();

// POST /api/reports/:linkId — Create report if none exists, or return existing
reportRoutes.post("/:linkId", async (c) => {
  const user = c.var.user;
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  // Verify ownership
  const link = await db.select({ id: links.id, userId: links.userId })
    .from(links)
    .where(eq(links.id, linkId))
    .get();
  if (!link || link.userId !== user.id) throw notFound("Link not found");

  // Return existing report if present
  const existing = await db.select({
    token: publicReports.token,
    isEnabled: publicReports.isEnabled,
    createdAt: publicReports.createdAt,
    linkId: publicReports.linkId,
  }).from(publicReports)
    .where(eq(publicReports.linkId, linkId))
    .get();
  if (existing) {
    return c.json({ data: existing });
  }

  // Create new report
  const id = crypto.randomUUID();
  const token = generateReportToken();
  const now = new Date();

  await db.insert(publicReports).values({
    id,
    linkId,
    token,
    isEnabled: true,
    createdAt: now,
  });

  return c.json({
    data: { linkId, token, isEnabled: true, createdAt: now },
  }, 201);
});

// PUT /api/reports/:linkId — Toggle isEnabled on existing report
reportRoutes.put("/:linkId", async (c) => {
  const user = c.var.user;
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  // Verify ownership
  const link = await db.select({ id: links.id, userId: links.userId })
    .from(links)
    .where(eq(links.id, linkId))
    .get();
  if (!link || link.userId !== user.id) throw notFound("Link not found");

  const report = await db.select().from(publicReports)
    .where(eq(publicReports.linkId, linkId))
    .get();
  if (!report) throw notFound("Report not found");

  const newEnabled = !report.isEnabled;
  await db.update(publicReports)
    .set({ isEnabled: newEnabled })
    .where(eq(publicReports.id, report.id));

  // Re-fetch to return fresh data
  const updated = await db.select({
    token: publicReports.token,
    isEnabled: publicReports.isEnabled,
    createdAt: publicReports.createdAt,
    linkId: publicReports.linkId,
  }).from(publicReports).where(eq(publicReports.id, report.id)).get();
  return c.json({ data: updated });
});

/** Public handler for GET /api/public-report/:token — no auth required. */
export async function publicReportRoute(c: Context<AppEnv>) {
  const token = c.req.param("token") as string;
  const db = getDb(c.env.DB);

  // Single JOIN query instead of two sequential queries
  const row = await db.select({
    reportEnabled: publicReports.isEnabled,
    linkId: links.id,
    slug: links.slug,
    title: links.title,
    isActive: links.isActive,
  }).from(publicReports)
    .innerJoin(links, eq(publicReports.linkId, links.id))
    .where(eq(publicReports.token, token))
    .get();

  if (!row || !row.reportEnabled) {
    return c.json({ error: "Not found" }, 404);
  }

  // Don't expose stats for deactivated links
  if (!row.isActive) {
    return c.json({ error: "Not found" }, 404);
  }

  // Total clicks (all time)
  const totalRow = await db.select({ totalClicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)` })
    .from(linkStats)
    .where(eq(linkStats.linkId, row.linkId))
    .get();
  const totalClicks = totalRow?.totalClicks ?? 0;

  // Last 30 days timeseries
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const rows = await db.select({ date: linkStats.date, clicks: linkStats.clicks })
    .from(linkStats)
    .where(and(eq(linkStats.linkId, row.linkId), gte(linkStats.date, cutoff)))
    .orderBy(linkStats.date);

  const timeseries = {
    labels: rows.map((r) => formatDate(r.date)),
    clicks: rows.map((r) => r.clicks),
  };

  return c.json({
    data: {
      slug: row.slug,
      title: row.title ?? null,
      totalClicks,
      timeseries,
    },
  });
}

export default reportRoutes;
