import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../../db";
import { publicReports, links } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { requireAccessibleLink } from "../../lib/link-access";
import { dailyClickSeries, sumClicks } from "../../services/analytics";
import type { AppEnv, AuthedEnv } from "../../types";

function generateReportToken(): string { return "rpt_" + crypto.randomUUID().replace(/-/g, ""); }

const reportRoutes = new Hono<AuthedEnv>();

/** Read the report row for a link, or undefined. */
function selectReport(db: Database, linkId: string) {
  return db.select().from(publicReports).where(eq(publicReports.linkId, linkId)).get();
}

// GET /api/reports/:linkId — Read-only: the report for a link, or null. Never creates.
reportRoutes.get("/:linkId", async (c) => {
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  await requireAccessibleLink(db, linkId, c.var.user.id);

  const report = await selectReport(db, linkId);
  return c.json({ data: report ?? null });
});

// POST /api/reports/:linkId — Create the report: 201 when created, 200 with the existing one.
reportRoutes.post("/:linkId", async (c) => {
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  const link = await requireAccessibleLink(db, linkId, c.var.user.id);
  // publicReportRoute 404s an internal link, so a report on one would hand out a dead URL.
  if (link.isInternal) throw badRequest("Internal links cannot have a public report");

  // The insert is the existence check, so two concurrent creates cannot both win.
  const created = await db.insert(publicReports)
    .values({ linkId, token: generateReportToken(), createdAt: new Date() })
    .onConflictDoNothing({ target: publicReports.linkId })
    .returning()
    .get();
  if (created) return c.json({ data: created }, 201);

  const existing = await selectReport(db, linkId);
  if (!existing) throw notFound("Link not found");
  return c.json({ data: existing });
});

// PUT /api/reports/:linkId — Set isEnabled on an existing report
reportRoutes.put("/:linkId", async (c) => {
  const linkId = c.req.param("linkId");
  const db = getDb(c.env.DB);

  const link = await requireAccessibleLink(db, linkId, c.var.user.id);

  const body = await parseJsonBody<{ isEnabled?: unknown }>(c);
  if (typeof body.isEnabled !== "boolean") throw badRequest("isEnabled must be a boolean");
  const isEnabled = body.isEnabled;
  if (isEnabled && link.isInternal) throw badRequest("Internal links cannot have a public report");

  const report = await db.update(publicReports)
    .set({ isEnabled })
    .where(eq(publicReports.linkId, linkId))
    .returning()
    .get();
  if (!report) throw notFound("Report not found");

  return c.json({ data: report });
});

/** Public handler for GET /api/public-report/:token — no auth required. */
export async function publicReportRoute(c: Context<AppEnv>) {
  const token = c.req.param("token") as string;
  const db = getDb(c.env.DB);

  // Internal links require a session to redirect, so their stats stay behind auth too.
  const row = await db.select({ linkId: links.id, slug: links.slug, title: links.title })
    .from(publicReports)
    .innerJoin(links, eq(publicReports.linkId, links.id))
    .where(and(eq(publicReports.token, token), eq(publicReports.isEnabled, true), eq(links.isInternal, false)))
    .get();
  if (!row) throw notFound("Not found");

  const [totalClicks, timeseries] = await Promise.all([
    sumClicks(db, row.linkId),
    dailyClickSeries(db, row.linkId, 30),
  ]);

  return c.json({
    data: {
      slug: row.slug,
      title: row.title,
      totalClicks,
      timeseries,
    },
  });
}

export default reportRoutes;
