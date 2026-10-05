import { and, eq, gte, sql } from "drizzle-orm";
import { linkStats } from "../db/schema";
import type { Database } from "../db";
import { formatDate, statsCutoff } from "../lib/date";

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

type Visitor = Pick<ClickEvent, "country" | "city" | "region" | "userAgent" | "referer">;

/** The visitor fields of a click, read from the request's `cf` object and headers. */
export function requestVisitor(req: Request): Visitor {
  const cf = req.cf;
  return {
    country: (cf?.country as string) || "",
    city: (cf?.city as string) || "",
    region: (cf?.region as string) || "",
    userAgent: req.headers.get("user-agent") || "",
    referer: req.headers.get("referer") || "",
  };
}

export function writeClickEvent(analytics: AnalyticsEngineDataset, event: ClickEvent): void {
  // AE positional layout. Every writer goes through this function; the readers
  // in src/routes/api/stats.ts must match it.
  //   index1  = linkId
  //   blob1   = slug
  //   blob2   = country
  //   blob3   = user-agent
  //   blob4   = referer
  //   blob5   = city
  //   blob6   = destinationUrl
  //   blob7   = region
  //   double1 = Date.now()
  analytics.writeDataPoint({
    indexes: [event.linkId],
    blobs: [event.slug, event.country, event.userAgent, event.referer, event.city, event.destinationUrl, event.region],
    doubles: [Date.now()],
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

/** Daily clicks for a link over the last `days` days from `link_stats`, labelled for a chart. */
export async function dailyClickSeries(
  db: Database,
  linkId: string,
  days: number
): Promise<{ labels: string[]; clicks: number[] }> {
  const rows = await db
    .select({ date: linkStats.date, clicks: linkStats.clicks })
    .from(linkStats)
    .where(and(eq(linkStats.linkId, linkId), gte(linkStats.date, statsCutoff(days))))
    .orderBy(linkStats.date);
  return { labels: rows.map((r) => formatDate(r.date)), clicks: rows.map((r) => r.clicks) };
}

export type AERow = Record<string, string | number>;

// The AE SQL API has no parameter binding: callers must sanitize every interpolated value.
export async function queryAnalyticsEngine(
  accountId: string,
  apiToken: string,
  query: string
): Promise<{ data: AERow[] }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: query,
  });
  if (!resp.ok) {
    throw new Error(`AE API returned ${resp.status}: ${resp.statusText}`);
  }
  const result = await resp.json<{ success: boolean; errors?: { message: string }[]; data?: AERow[] }>();
  if (!result.success) {
    const msg = result.errors?.[0]?.message ?? "Analytics Engine query failed";
    throw new Error(msg);
  }
  return { data: result.data ?? [] };
}
