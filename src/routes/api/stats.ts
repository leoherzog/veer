import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and, gte } from "drizzle-orm";
import { getDb } from "../../db";
import { links, linkStats } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { requireTeamMember } from "../../lib/team";
import { queryAnalyticsEngine } from "../../services/analytics";
import { parseUserAgent } from "../../services/useragent";
import { formatDate, formatHour, formatWeek } from "../../lib/date";
import type { AppEnv } from "../../types";

type StatsEnv = AppEnv & { Variables: AppEnv["Variables"] & { aeAvailable: boolean } };

const statsRoutes = new Hono<StatsEnv>();

const LINK_ID_RE = /^[0-9a-f-]{36}$/i;

function parseDays(raw: string | undefined, max = 90, def = 30): number {
  const n = raw ? parseInt(raw, 10) : def;
  if (isNaN(n) || n < 1) return def;
  return Math.min(n, max);
}

// Middleware: validate linkId format + ownership, check AE credentials
statsRoutes.use("/:linkId/*", async (c, next) => {
  const linkId = c.req.param("linkId");
  if (!LINK_ID_RE.test(linkId)) throw badRequest("Invalid link ID");
  const db = getDb(c.env.DB);
  const link = await db.select({ userId: links.userId, teamId: links.teamId }).from(links).where(eq(links.id, linkId)).get();
  if (!link) throw notFound("Link not found");
  const userId = c.var.user!.id;
  if (link.userId !== userId) {
    // Allow team members to view stats for team-owned links
    if (!link.teamId) throw notFound("Link not found");
    try {
      await requireTeamMember(db, link.teamId, userId);
    } catch {
      throw notFound("Link not found");
    }
  }
  c.set("aeAvailable", !!(c.env.CF_ACCOUNT_ID && c.env.CF_API_TOKEN));
  await next();
});

function logAEError(endpoint: string, e: unknown): void {
  console.error(JSON.stringify({ message: "AE query failed", endpoint, error: e instanceof Error ? e.message : String(e) }));
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "Direct";
  }
}

// Aggregate a map and return sorted array
function aggregateMap(map: Map<string, number>): { name: string; clicks: number }[] {
  return [...map.entries()]
    .map(([name, clicks]) => ({ name, clicks }))
    .sort((a, b) => b.clicks - a.clicks);
}

// GET /api/stats/:linkId/timeseries
statsRoutes.get("/:linkId/timeseries", async (c) => {
  const linkId = c.req.param("linkId");

  const rawPeriod = c.req.query("period") || "day";
  const period = (["hour", "day", "week"].includes(rawPeriod) ? rawPeriod : "day") as "hour" | "day" | "week";
  const days = parseDays(c.req.query("days"));

  if (!c.var.aeAvailable) {
    return fallbackTimeseries(c, linkId, days);
  }

  try {
    const accountId = c.env.CF_ACCOUNT_ID!;
    const apiToken = c.env.CF_API_TOKEN!;
    let query: string;
    let formatFn: (s: string) => string;
    let aliasCol: string;

    if (period === "hour") {
      aliasCol = "hour";
      const hours = Math.min(days * 24, 48);
      query = `SELECT toStartOfHour(timestamp) as hour, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval '${hours}' hour GROUP BY hour ORDER BY hour`;
      formatFn = formatHour;
    } else if (period === "week") {
      aliasCol = "week";
      query = `SELECT toStartOfWeek(timestamp) as week, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval '${days}' day GROUP BY week ORDER BY week`;
      formatFn = formatWeek;
    } else {
      aliasCol = "date";
      query = `SELECT toDate(timestamp) as date, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval '${days}' day GROUP BY date ORDER BY date`;
      formatFn = formatDate;
    }

    const result = await queryAnalyticsEngine(accountId, apiToken, query);
    const labels = result.data.map((r) => formatFn(String(r[aliasCol])));
    const clicks = result.data.map((r) => Number(r.clicks));

    return c.json({ data: { labels, clicks } });
  } catch (e) {
    logAEError("timeseries", e);
    return fallbackTimeseries(c, linkId, days);
  }
});

async function fallbackTimeseries(c: Context<StatsEnv>, linkId: string, days: number) {
  const db = getDb(c.env.DB);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select({ date: linkStats.date, clicks: linkStats.clicks })
    .from(linkStats)
    .where(and(eq(linkStats.linkId, linkId), gte(linkStats.date, cutoff)))
    .orderBy(linkStats.date);

  const labels = rows.map((r) => formatDate(r.date));
  const clicks = rows.map((r) => r.clicks);

  return c.json({ data: { labels, clicks }, fallback: true });
}

// GET /api/stats/:linkId/geo
statsRoutes.get("/:linkId/geo", async (c) => {
  const linkId = c.req.param("linkId");

  const days = parseDays(c.req.query("days"));

  if (!c.var.aeAvailable) {
    return c.json({ data: { countries: [], cities: [] }, fallback: true });
  }

  try {
    const accountId = c.env.CF_ACCOUNT_ID!;
    const apiToken = c.env.CF_API_TOKEN!;
    const interval = `'${days}' day`;
    const [countriesResult, citiesResult] = await Promise.all([
      queryAnalyticsEngine(accountId, apiToken,
        `SELECT blob2 as country, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval ${interval} GROUP BY country ORDER BY clicks DESC LIMIT 20`),
      queryAnalyticsEngine(accountId, apiToken,
        `SELECT blob5 as city, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval ${interval} GROUP BY city ORDER BY clicks DESC LIMIT 20`),
    ]);

    const countries = countriesResult.data.map((r) => ({ name: r.country || "Unknown", clicks: Number(r.clicks) }));
    const cities = citiesResult.data.map((r) => ({ name: r.city || "Unknown", clicks: Number(r.clicks) }));

    return c.json({ data: { countries, cities } });
  } catch (e) {
    logAEError("geo", e);
    return c.json({ data: { countries: [], cities: [] }, fallback: true });
  }
});

// GET /api/stats/:linkId/devices
statsRoutes.get("/:linkId/devices", async (c) => {
  const linkId = c.req.param("linkId");

  const days = parseDays(c.req.query("days"));

  if (!c.var.aeAvailable) {
    return c.json({ data: { browsers: [], os: [], devices: [] }, fallback: true });
  }

  try {
    const accountId = c.env.CF_ACCOUNT_ID!;
    const apiToken = c.env.CF_API_TOKEN!;
    const result = await queryAnalyticsEngine(accountId, apiToken,
      `SELECT blob3 as userAgent, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval '${days}' day GROUP BY userAgent ORDER BY clicks DESC LIMIT 200`);

    const browsers = new Map<string, number>();
    const osMap = new Map<string, number>();
    const deviceMap = new Map<string, number>();

    for (const row of result.data) {
      const clicks = Number(row.clicks);
      const ua = parseUserAgent(String(row.userAgent));

      browsers.set(ua.browser, (browsers.get(ua.browser) || 0) + clicks);
      osMap.set(ua.os, (osMap.get(ua.os) || 0) + clicks);
      deviceMap.set(ua.device, (deviceMap.get(ua.device) || 0) + clicks);
    }

    return c.json({
      data: {
        browsers: aggregateMap(browsers),
        os: aggregateMap(osMap),
        devices: aggregateMap(deviceMap),
      },
    });
  } catch (e) {
    logAEError("devices", e);
    return c.json({ data: { browsers: [], os: [], devices: [] }, fallback: true });
  }
});

// GET /api/stats/:linkId/referrers
statsRoutes.get("/:linkId/referrers", async (c) => {
  const linkId = c.req.param("linkId");

  const days = parseDays(c.req.query("days"));

  if (!c.var.aeAvailable) {
    return c.json({ data: [], fallback: true });
  }

  try {
    const accountId = c.env.CF_ACCOUNT_ID!;
    const apiToken = c.env.CF_API_TOKEN!;
    const result = await queryAnalyticsEngine(accountId, apiToken,
      `SELECT blob4 as referrer, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval '${days}' day AND blob4 != '' GROUP BY referrer ORDER BY clicks DESC LIMIT 200`);

    // Aggregate by hostname
    const hostMap = new Map<string, number>();
    for (const row of result.data) {
      const host = extractHostname(String(row.referrer));
      const clicks = Number(row.clicks);
      hostMap.set(host, (hostMap.get(host) || 0) + clicks);
    }

    const data = [...hostMap.entries()]
      .map(([source, clicks]) => ({ source, clicks }))
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 20);

    return c.json({ data });
  } catch (e) {
    logAEError("referrers", e);
    return c.json({ data: [], fallback: true });
  }
});

// GET /api/stats/:linkId/summary
statsRoutes.get("/:linkId/summary", async (c) => {
  const linkId = c.req.param("linkId");

  const days = parseDays(c.req.query("days"));

  if (!c.var.aeAvailable) {
    return fallbackSummary(c, linkId, days);
  }

  try {
    const accountId = c.env.CF_ACCOUNT_ID!;
    const apiToken = c.env.CF_API_TOKEN!;
    const interval = `'${days}' day`;
    const [summaryResult, countryResult, referrerResult] = await Promise.all([
      queryAnalyticsEngine(accountId, apiToken,
        `SELECT count() as totalClicks, uniq(blob3) as uniqueUserAgents FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval ${interval}`),
      queryAnalyticsEngine(accountId, apiToken,
        `SELECT blob2 as country, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval ${interval} GROUP BY country ORDER BY clicks DESC LIMIT 1`),
      queryAnalyticsEngine(accountId, apiToken,
        `SELECT blob4 as referrer, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp > now() - interval ${interval} AND blob4 != '' GROUP BY referrer ORDER BY clicks DESC LIMIT 1`),
    ]);

    const summary = summaryResult.data[0] || {};
    const topCountry = countryResult.data[0]?.country || null;
    const topReferrer = referrerResult.data[0]
      ? extractHostname(String(referrerResult.data[0].referrer))
      : null;

    return c.json({
      data: {
        totalClicks: Number(summary.totalClicks || 0),
        uniqueUserAgents: Number(summary.uniqueUserAgents || 0),
        topCountry,
        topReferrer,
        period: { days },
      },
    });
  } catch (e) {
    logAEError("summary", e);
    return fallbackSummary(c, linkId, days);
  }
});

async function fallbackSummary(c: Context<StatsEnv>, linkId: string, days: number) {
  const db = getDb(c.env.DB);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select({ clicks: linkStats.clicks })
    .from(linkStats)
    .where(and(eq(linkStats.linkId, linkId), gte(linkStats.date, cutoff)));

  const totalClicks = rows.reduce((sum, r) => sum + r.clicks, 0);

  return c.json({
    data: {
      totalClicks,
      uniqueUserAgents: 0,
      topCountry: null,
      topReferrer: null,
      period: { days },
    },
    fallback: true,
  });
}

// GET /api/stats/:linkId/ab - A/B test variant performance
statsRoutes.get("/:linkId/ab", async (c) => {
  const linkId = c.req.param("linkId");
  const days = parseDays(c.req.query("days"), 90, 30);

  if (c.var.aeAvailable) {
    try {
      const sql = `SELECT blob6 as destinationUrl, count() as clicks FROM veer_clicks WHERE index1 = '${linkId}' AND timestamp >= NOW() - INTERVAL '${days}' DAY GROUP BY blob6 ORDER BY clicks DESC LIMIT 20`;
      const result = await queryAnalyticsEngine(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, sql);
      const variants = (result.data || []).map((row) => ({
        url: String(row.destinationUrl || "(unknown)"),
        clicks: parseInt(String(row.clicks)) || 0,
      }));
      return c.json({ data: variants });
    } catch (e) {
      logAEError("ab", e);
    }
  }

  // Fallback: no per-variant data available from D1 (link_stats doesn't track destination)
  return c.json({ data: [], fallback: true });
});

export default statsRoutes;
