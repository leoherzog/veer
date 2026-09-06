import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and, sql, gte } from "drizzle-orm";
import { getDb, type Database } from "../../db";
import { publicReports, links, linkStats } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { canAccessLink } from "../../lib/link-access";
import { formatDate } from "../../lib/date";
import type { AppEnv } from "../../types";

function generateReportToken(): string { return "rpt_" + crypto.randomUUID().replace(/-/g, ""); }

const reportRoutes = new Hono<AppEnv>();

/** Load a link the caller may read, or throw 404. Team members count as callers. */
async function requireAccessibleLink(db: Database, linkId: string, userId: string) {
  const link = await db.select({ id: links.id, userId: links.userId, teamId: links.teamId, isInternal: links.isInternal })
    .from(links)
    .where(eq(links.id, linkId))
    .get();
  if (!link) throw notFound("Link not found");
  if (!(await canAccessLink(db, link, userId))) throw notFound("Link not found");
  return link;
}

/** Read the report row for a link, or null. */
function selectReport(db: Database, linkId: string) {
  return db.select({
    token: publicReports.token,
    isEnabled: publicReports.isEnabled,
    createdAt: publicReports.createdAt,
    linkId: publicReports.linkId,
  }).from(publicReports)
    .where(eq(publicReports.linkId, linkId))
    .get();
}

// GET /api/reports/:linkId — Read-only: the report for a link, or null. Never creates.
reportRoutes.get("/:linkId", async (c) => {
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  await requireAccessibleLink(db, linkId, c.var.user!.id);

  const report = await selectReport(db, linkId);
  return c.json({ data: report ?? null });
});

// POST /api/reports/:linkId — Create report if none exists, or return existing
reportRoutes.post("/:linkId", async (c) => {
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  const link = await requireAccessibleLink(db, linkId, c.var.user!.id);
  // publicReportRoute 404s an internal link, so a report on one would hand out a dead URL.
  if (link.isInternal) throw badRequest("Internal links cannot have a public report");

  const existing = await selectReport(db, linkId);
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

// PUT /api/reports/:linkId — Set isEnabled on an existing report
reportRoutes.put("/:linkId", async (c) => {
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  const link = await requireAccessibleLink(db, linkId, c.var.user!.id);

  const body = await parseJsonBody<{ isEnabled?: unknown }>(c);
  if (typeof body.isEnabled !== "boolean") throw badRequest("isEnabled must be a boolean");
  const isEnabled = body.isEnabled;
  if (isEnabled && link.isInternal) throw badRequest("Internal links cannot have a public report");

  const report = await db.select().from(publicReports)
    .where(eq(publicReports.linkId, linkId))
    .get();
  if (!report) throw notFound("Report not found");

  await db.update(publicReports)
    .set({ isEnabled })
    .where(eq(publicReports.id, report.id));

  return c.json({ data: { token: report.token, isEnabled, createdAt: report.createdAt, linkId: report.linkId } });
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
    isInternal: links.isInternal,
  }).from(publicReports)
    .innerJoin(links, eq(publicReports.linkId, links.id))
    .where(eq(publicReports.token, token))
    .get();

  if (!row || !row.reportEnabled) {
    return c.json({ error: "Not found" }, 404);
  }

  // Deactivated links expose nothing. Internal links require a session to
  // redirect, so their stats stay behind auth too.
  if (!row.isActive || row.isInternal) {
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
