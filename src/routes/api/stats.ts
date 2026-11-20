import { Hono } from "hono";
import type { Context } from "hono";
import { routePath } from "hono/route";
import { getDb } from "../../db";
import { badRequest } from "../../lib/errors";
import { requireAccessibleLink } from "../../lib/link-access";
import { parseDays } from "../../lib/request";
import { DAY_MS, HOUR_MS, formatDate, formatHour, formatWeek, statsCutoff } from "../../lib/date";
import { clickSeries, dailyClickSeries, queryAnalyticsEngine, sumClicks, type AERow } from "../../services/analytics";
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

/** Clicks in a group. AE downsamples busy indexes, and each stored row stands for `_sample_interval` clicks. */
const CLICKS = "SUM(_sample_interval)";

/**
 * Answer from Analytics Engine, or from `fallback` when the AE credentials are unset or a query fails.
 * @param run - Builds the response; its argument runs one AE SQL query and resolves to the rows.
 */
async function withAE(
  c: Context<AppEnv>,
  fallback: () => Response | Promise<Response>,
  run: (query: AEQuery) => Promise<Response>,
): Promise<Response> {
  const { CF_ACCOUNT_ID, CF_API_TOKEN } = c.env;
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return fallback();
  try {
    return await run((sql) => queryAnalyticsEngine(CF_ACCOUNT_ID, CF_API_TOKEN, sql));
  } catch (e) {
    console.error(JSON.stringify({ message: "AE query failed", route: routePath(c), error: e instanceof Error ? e.message : String(e) }));
    return fallback();
  }
}

/** WHERE clause for one link's clicks in the trailing window. Both values must already be validated. */
function clicksWhere(linkId: string, span: number, unit: "day" | "hour" = "day"): string {
  return `index1 = '${linkId}' AND timestamp > now() - interval '${span}' ${unit}`;
}

/**
 * The `limit` most-clicked groups in `where`.
 * @param columns - Result alias to AE column, e.g. `{ country: "blob2" }`; the query groups by every alias.
 */
function topQuery(c: Context<AppEnv>, columns: Record<string, string>, where: string, limit: number): string {
  const aliases = Object.keys(columns);
  const select = aliases.map((alias) => `${columns[alias]} as ${alias}`).join(", ");
  return `SELECT ${select}, ${CLICKS} as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY ${aliases.join(", ")} ORDER BY clicks DESC LIMIT ${limit}`;
}

interface Count {
  name: string;
  clicks: number;
}

/** Name each AE row with `name` and read its clicks as a number. */
function toCounts(rows: AERow[], name: (row: AERow) => string): Count[] {
  return rows.map((row) => ({ name: name(row), clicks: Number(row.clicks) }));
}

/** Merge counts that share a name, most clicks first. */
function aggregate(counts: Count[]): Count[] {
  const totals = new Map<string, number>();
  for (const { name, clicks } of counts) totals.set(name, (totals.get(name) ?? 0) + clicks);
  return [...totals].map(([name, clicks]) => ({ name, clicks })).sort((a, b) => b.clicks - a.clicks);
}

/** Referrer hostnames by clicks. `/referrers` and `/summary` both read this, so they agree. */
async function referrerHosts(c: Context<AppEnv>, query: AEQuery, where: string): Promise<Count[]> {
  const rows = await query(topQuery(c, { referrer: "blob4" }, `${where} AND blob4 != ''`, 200));
  return aggregate(toCounts(rows, (row) => {
    const referrer = String(row.referrer);
    return URL.parse(referrer)?.hostname ?? referrer;
  }));
}

/**
 * Timeseries buckets. Weeks are summed from UTC days into Monday-start weeks here,
 * so their boundaries never depend on how AE defines a week.
 */
const PERIODS = {
  hour: { bucket: "toStartOfHour(timestamp)", step: HOUR_MS, format: formatHour },
  day: { bucket: "toStartOfDay(timestamp)", step: DAY_MS, format: formatDate },
  week: { bucket: "toStartOfDay(timestamp)", step: 7 * DAY_MS, format: formatWeek },
};

/** Start of the first bucket in a timeseries window, in ms. */
function windowStart(period: keyof typeof PERIODS, days: number, hours: number): number {
  if (period === "hour") return Math.floor((Date.now() - hours * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const firstDay = Date.parse(statsCutoff(days));
  if (period === "day") return firstDay;
  return firstDay - ((new Date(firstDay).getUTCDay() + 6) % 7) * DAY_MS;
}

statsRoutes.get("/:linkId/timeseries", (c) => {
  const linkId = c.req.param("linkId");
  const rawPeriod = c.req.query("period");
  const period = rawPeriod === "hour" || rawPeriod === "week" ? rawPeriod : "day";
  const days = parseDays(c.req.query("days"));

  return withAE(
    c,
    async () => c.json({ data: await dailyClickSeries(getDb(c.env.DB), linkId, days), fallback: true }),
    async (query) => {
      const { bucket, step, format } = PERIODS[period];
      const hours = Math.min(days * 24, 48);
      const where = period === "hour" ? clicksWhere(linkId, hours, "hour") : clicksWhere(linkId, days);
      const rows = await query(`SELECT toUnixTimestamp(${bucket}) as t, ${CLICKS} as clicks FROM ${c.env.AE_DATASET} WHERE ${where} GROUP BY t ORDER BY t`);
      return c.json({
        data: clickSeries(
          rows.map((r) => ({ at: Number(r.t) * 1000, clicks: Number(r.clicks) })),
          { start: windowStart(period, days, hours), end: Date.now(), step },
          format,
        ),
      });
    },
  );
});

statsRoutes.get("/:linkId/geo", (c) => {
  const where = clicksWhere(c.req.param("linkId"), parseDays(c.req.query("days")));

  return withAE(
    c,
    () => c.json({ data: { countries: [], cities: [] }, fallback: true }),
    async (query) => {
      const [countries, cities] = await Promise.all([
        query(topQuery(c, { country: "blob2" }, where, 20)),
        query(topQuery(c, { city: "blob5", country: "blob2" }, where, 200)),
      ]);
      return c.json({
        data: {
          countries: toCounts(countries, (r) => String(r.country || "Unknown")),
          // Rows without a city differ only by country, so they merge into one "Unknown".
          cities: aggregate(toCounts(cities, (r) => (r.city ? [r.city, r.country].filter(Boolean).join(", ") : "Unknown"))).slice(0, 20),
        },
      });
    },
  );
});

statsRoutes.get("/:linkId/devices", (c) => {
  const where = clicksWhere(c.req.param("linkId"), parseDays(c.req.query("days")));

  return withAE(
    c,
    () => c.json({ data: { browsers: [], os: [], devices: [] }, fallback: true }),
    async (query) => {
      const rows = await query(topQuery(c, { userAgent: "blob3" }, where, 200));
      const parsed = toCounts(rows, (r) => String(r.userAgent)).map(({ name, clicks }) => ({ ua: parseUserAgent(name), clicks }));
      return c.json({
        data: {
          browsers: aggregate(parsed.map(({ ua, clicks }) => ({ name: ua.browser, clicks }))),
          os: aggregate(parsed.map(({ ua, clicks }) => ({ name: ua.os, clicks }))),
          devices: aggregate(parsed.map(({ ua, clicks }) => ({ name: ua.device, clicks }))),
        },
      });
    },
  );
});

statsRoutes.get("/:linkId/referrers", (c) => {
  const where = clicksWhere(c.req.param("linkId"), parseDays(c.req.query("days")));

  return withAE(
    c,
    () => c.json({ data: [], fallback: true }),
    async (query) => {
      const hosts = await referrerHosts(c, query, where);
      return c.json({ data: hosts.slice(0, 20).map(({ name, clicks }) => ({ source: name, clicks })) });
    },
  );
});

statsRoutes.get("/:linkId/summary", (c) => {
  const linkId = c.req.param("linkId");
  const days = parseDays(c.req.query("days"));
  const where = clicksWhere(linkId, days);

  return withAE(
    c,
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
      const [summaryRows, countryRows, hosts] = await Promise.all([
        query(`SELECT ${CLICKS} as totalClicks, count(DISTINCT blob3) as uniqueUserAgents FROM ${c.env.AE_DATASET} WHERE ${where}`),
        query(topQuery(c, { country: "blob2" }, where, 1)),
        referrerHosts(c, query, where),
      ]);

      const summary = summaryRows[0] ?? {};
      return c.json({
        data: {
          totalClicks: Number(summary.totalClicks ?? 0),
          uniqueUserAgents: Number(summary.uniqueUserAgents ?? 0),
          topCountry: countryRows[0]?.country || null,
          topReferrer: hosts[0]?.name ?? null,
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
    () => c.json({ data: [], fallback: true }),
    async (query) => {
      const rows = await query(topQuery(c, { destinationUrl: "blob6" }, where, 20));
      return c.json({
        data: toCounts(rows, (r) => String(r.destinationUrl || "(unknown)")).map(({ name, clicks }) => ({ url: name, clicks })),
      });
    },
  );
});

export default statsRoutes;
