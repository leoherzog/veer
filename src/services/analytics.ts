import { and, eq, gte, sql } from "drizzle-orm";
import { linkStats } from "../db/schema";
import type { Database } from "../db";
import { DAY_MS, formatDate, statsCutoff } from "../lib/date";

/** One click as `writeClickEvent` stores it. AE adds its own `timestamp`, so the event carries none. */
interface ClickEvent {
  linkId: string;
  slug: string;
  destinationUrl: string;
  country: string;
  city: string;
  region: string;
  userAgent: string;
  referer: string;
}

export type Visitor = Pick<ClickEvent, "country" | "city" | "region" | "userAgent" | "referer">;

/** The visitor fields of a click, read from the request's `cf` object and headers. */
export function requestVisitor(req: Request): Visitor {
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  return {
    country: cf?.country ?? "",
    city: cf?.city ?? "",
    region: cf?.region ?? "",
    userAgent: req.headers.get("user-agent") ?? "",
    referer: req.headers.get("referer") ?? "",
  };
}

export function writeClickEvent(analytics: AnalyticsEngineDataset, event: ClickEvent): void {
  // AE positional layout. Every writer goes through this function; the readers
  // in src/routes/api/stats.ts must match it.
  //   index1 = linkId
  //   blob1  = slug
  //   blob2  = country
  //   blob3  = user-agent
  //   blob4  = referer
  //   blob5  = city
  //   blob6  = destinationUrl (the chosen target, before param forwarding)
  //   blob7  = region
  analytics.writeDataPoint({
    indexes: [event.linkId],
    blobs: [event.slug, event.country, event.userAgent, event.referer, event.city, event.destinationUrl, event.region],
  });
}

/**
 * Add clicks to today's row in `link_stats`, the permanent daily aggregate that
 * feeds the maxClicks cap and lifetime totals (AE holds ~90-day detail).
 */
export async function upsertDailyStats(db: Database, linkId: string, clicks: number): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  await db
    .insert(linkStats)
    .values({ linkId, date, clicks })
    .onConflictDoUpdate({
      target: [linkStats.linkId, linkStats.date],
      set: { clicks: sql`${linkStats.clicks} + ${clicks}` },
    });
}

/**
 * Total clicks for a link from `link_stats`.
 * @param since - YYYY-MM-DD lower bound; omit for the all-time total.
 */
export async function sumClicks(db: Database, linkId: string, since?: string): Promise<number> {
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${linkStats.clicks}), 0)` })
    .from(linkStats)
    .where(and(eq(linkStats.linkId, linkId), since ? gte(linkStats.date, since) : undefined))
    .get();
  return row?.total ?? 0;
}

/** A chart series: one label and one click count per bucket. */
export interface ClickSeries {
  labels: string[];
  clicks: number[];
}

/**
 * Zero-filled series with one bucket every `step` ms from `start` through `end`.
 * Each row's clicks go to the bucket its time `at` falls in. A row just outside
 * the range, from clock skew between AE and the Worker, joins the nearest bucket.
 */
export function clickSeries(
  rows: { at: number; clicks: number }[],
  range: { start: number; end: number; step: number },
  format: (iso: string) => string,
): ClickSeries {
  const count = Math.floor((range.end - range.start) / range.step) + 1;
  const clicks = new Array<number>(count).fill(0);
  for (const row of rows) {
    const i = Math.floor((row.at - range.start) / range.step);
    clicks[Math.min(Math.max(i, 0), count - 1)] += row.clicks;
  }
  const labels = clicks.map((_, i) => format(new Date(range.start + i * range.step).toISOString()));
  return { labels, clicks };
}

/** Daily clicks for a link from `link_stats`, one bucket per UTC day from `statsCutoff(days)` through today. */
export async function dailyClickSeries(db: Database, linkId: string, days: number): Promise<ClickSeries> {
  const since = statsCutoff(days);
  const rows = await db
    .select({ date: linkStats.date, clicks: linkStats.clicks })
    .from(linkStats)
    .where(and(eq(linkStats.linkId, linkId), gte(linkStats.date, since)));
  return clickSeries(
    rows.map((r) => ({ at: Date.parse(r.date), clicks: r.clicks })),
    { start: Date.parse(since), end: Date.now(), step: DAY_MS },
    formatDate,
  );
}

export type AERow = Record<string, string | number>;

/**
 * Run one query against the AE SQL API and return its rows.
 * The API has no parameter binding: callers must validate every interpolated value.
 */
export async function queryAnalyticsEngine(accountId: string, apiToken: string, query: string): Promise<AERow[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: query,
  });
  if (!resp.ok) {
    throw new Error(`AE API returned ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  // The default JSON format answers { meta, data, rows }.
  const { data } = await resp.json<{ data?: unknown }>();
  if (!Array.isArray(data)) throw new Error("AE API response has no data array");
  return data as AERow[];
}
