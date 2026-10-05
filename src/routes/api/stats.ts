import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../../db";
import { badRequest } from "../../lib/errors";
import { requireAccessibleLink } from "../../lib/link-access";
import { parseDays } from "../../lib/request";
import { formatDate, formatHour, formatWeek, statsCutoff } from "../../lib/date";
import { dailyClickSeries, queryAnalyticsEngine, sumClicks, type AERow } from "../../services/analytics";
import { parseUserAgent } from "../../services/useragent";
import type { AppEnv } from "../../types";

const statsRoutes = new Hono<AppEnv>();

const LINK_ID_RE = /^[0-9a-f-]{36}$/i;

// The linkId is interpolated into AE SQL, so its format is checked before anything else.
statsRoutes.use("/:linkId/*", async (c, next) => {
  const linkId = c.req.param("linkId");
  if (!LINK_ID_RE.test(linkId)) throw badRequest("Invalid link ID");
  await requireAccessibleLink(getDb(c.env.DB), linkId, c.var.user!.id);
  await next();
});

type AEQuery = (sql: string) => Promise<AERow[]>;

/**
 * Answer from Analytics Engine, or from `fallback` when the AE credentials are unset or a query fails.
 * @param run - Builds the response; its argument runs one AE SQL query and resolves to the rows.
 */
async function withAE(
  c: Context<AppEnv>,
  endpoint: string,
  fallback: () => Response | Promise<Response>,
  run: (query: AEQuery) => Promise<Response>,
): Promise<Response> {
  const { CF_ACCOUNT_ID, CF_API_TOKEN } = c.env;
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return fallback();
  try {
    return await run((sql) => queryAnalyticsEngine(CF_ACCOUNT_ID, CF_API_TOKEN, sql).then((r) => r.data));
  } catch (e) {
    console.error(JSON.stringify({ message: "AE query failed", endpoint, error: e instanceof Error ? e.message : String(e) }));
    return fallback();
  }
}

/** WHERE clause for one link's clicks in the trailing window. Both values must already be validated. */
function clicksWhere(linkId: string, span: number, unit: "day" | "hour" = "day"): string {
  return `index1 = '${linkId}' AND timestamp > now() - interval '${span}' ${unit}`;
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function aggregateMap(map: Map<string, number>): { name: string; clicks: number }[] {
  return [...map.entries()]
    .map(([name, clicks]) => ({ name, clicks }))
    .sort((a, b) => b.clicks - a.clicks);
}

const PERIODS = {
  hour: { bucket: "toStartOfHour(timestamp)", alias: "hour", format: formatHour },
  day: { bucket: "toDate(timestamp)", alias: "date", format: formatDate },
  week: { bucket: "toStartOfWeek(timestamp)", alias: "week", format: formatWeek },
};

statsRoutes.get("/:linkId/timeseries", (c) => {
  const linkId = c.req.param("linkId");
  const rawPeriod = c.req.query("period");
  const period = rawPeriod === "hour" || rawPeriod === "week" ? rawPeriod : "day";
  const days = parseDays(c.req.query("days"));

  return withAE(
    c,
    "timeseries",
    async () => c.json({ data: await dailyClickSeries(getDb(c.env.DB), linkId, days), fallback: true }),
    async (query) => {
      const { bucket, alias, format } = PERIODS[period];
      const where = period === "hour" ? clicksWhere(linkId, Math.min(days * 24, 48), "hour") : clicksWhere(linkId, days);
      const rows = await query(`SELECT ${bucket} as ${alias}, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY ${alias} ORDER BY ${alias}`);
      return c.json({
        data: {
          labels: rows.map((r) => format(String(r[alias]))),
          clicks: rows.map((r) => Number(r.clicks)),
        },
      });
    },
  );
});

statsRoutes.get("/:linkId/geo", (c) => {
  const where = clicksWhere(c.req.param("linkId"), parseDays(c.req.query("days")));

  return withAE(
    c,
    "geo",
    () => c.json({ data: { countries: [], cities: [] }, fallback: true }),
    async (query) => {
      const [countries, cities] = await Promise.all([
        query(`SELECT blob2 as country, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY country ORDER BY clicks DESC LIMIT 20`),
        query(`SELECT blob5 as city, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY city ORDER BY clicks DESC LIMIT 20`),
      ]);
      return c.json({
        data: {
          countries: countries.map((r) => ({ name: r.country || "Unknown", clicks: Number(r.clicks) })),
          cities: cities.map((r) => ({ name: r.city || "Unknown", clicks: Number(r.clicks) })),
        },
      });
    },
  );
});

statsRoutes.get("/:linkId/devices", (c) => {
  const where = clicksWhere(c.req.param("linkId"), parseDays(c.req.query("days")));

  return withAE(
    c,
    "devices",
    () => c.json({ data: { browsers: [], os: [], devices: [] }, fallback: true }),
    async (query) => {
      const rows = await query(`SELECT blob3 as userAgent, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY userAgent ORDER BY clicks DESC LIMIT 200`);

      const browsers = new Map<string, number>();
      const osMap = new Map<string, number>();
      const deviceMap = new Map<string, number>();

      for (const row of rows) {
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
    },
  );
});

statsRoutes.get("/:linkId/referrers", (c) => {
  const where = clicksWhere(c.req.param("linkId"), parseDays(c.req.query("days")));

  return withAE(
    c,
    "referrers",
    () => c.json({ data: [], fallback: true }),
    async (query) => {
      const rows = await query(`SELECT blob4 as referrer, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} AND blob4 != '' GROUP BY referrer ORDER BY clicks DESC LIMIT 200`);

      const hostMap = new Map<string, number>();
      for (const row of rows) {
        const host = extractHostname(String(row.referrer));
        hostMap.set(host, (hostMap.get(host) || 0) + Number(row.clicks));
      }

      return c.json({ data: aggregateMap(hostMap).slice(0, 20).map(({ name, clicks }) => ({ source: name, clicks })) });
    },
  );
});

statsRoutes.get("/:linkId/summary", (c) => {
  const linkId = c.req.param("linkId");
  const days = parseDays(c.req.query("days"));
  const where = clicksWhere(linkId, days);

  return withAE(
    c,
    "summary",
    async () => c.json({
      data: {
        totalClicks: await sumClicks(getDb(c.env.DB), linkId, statsCutoff(days)),
        uniqueUserAgents: 0,
        topCountry: null,
        topReferrer: null,
        period: { days },
      },
      fallback: true,
    }),
    async (query) => {
      const [summaryRows, countryRows, referrerRows] = await Promise.all([
        query(`SELECT count() as totalClicks, uniq(blob3) as uniqueUserAgents FROM ${c.env.AE_DATASET} WHERE ${where}`),
        query(`SELECT blob2 as country, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY country ORDER BY clicks DESC LIMIT 1`),
        query(`SELECT blob4 as referrer, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} AND blob4 != '' GROUP BY referrer ORDER BY clicks DESC LIMIT 1`),
      ]);

      const summary = summaryRows[0] || {};
      return c.json({
        data: {
          totalClicks: Number(summary.totalClicks || 0),
          uniqueUserAgents: Number(summary.uniqueUserAgents || 0),
          topCountry: countryRows[0]?.country || null,
          topReferrer: referrerRows[0] ? extractHostname(String(referrerRows[0].referrer)) : null,
          period: { days },
        },
      });
    },
  );
});

statsRoutes.get("/:linkId/ab", (c) => {
  const where = clicksWhere(c.req.param("linkId"), parseDays(c.req.query("days")));

  // link_stats has no per-destination breakdown, so the fallback is empty.
  return withAE(
    c,
    "ab",
    () => c.json({ data: [], fallback: true }),
    async (query) => {
      const rows = await query(`SELECT blob6 as destinationUrl, count() as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY blob6 ORDER BY clicks DESC LIMIT 20`);
      return c.json({
        data: rows.map((row) => ({
          url: String(row.destinationUrl || "(unknown)"),
          clicks: parseInt(String(row.clicks)) || 0,
        })),
      });
    },
  );
});

export default statsRoutes;
