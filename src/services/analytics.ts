import { sql } from "drizzle-orm";
import { linkStats } from "../db/schema";
import type { Database } from "../db";

interface ClickEvent {
  linkId: string;
  slug: string;
  destinationUrl: string;
  request: Request;
}

export function writeClickEvent(analytics: AnalyticsEngineDataset, event: ClickEvent): void {
  const cf = (event.request as Request & { cf?: IncomingRequestCfProperties }).cf;
  // AE blob index schema (must stay in sync with reads in src/routes/api/stats.ts):
  //   index1 = linkId
  //   blob1  = slug           (not queried)
  //   blob2  = country        (geo endpoint)
  //   blob3  = user-agent     (devices endpoint)
  //   blob4  = referer        (referrers endpoint)
  //   blob5  = city           (geo endpoint)
  //   blob6  = destinationUrl (A/B stats endpoint)
  //   blob7  = region         (not queried)
  analytics.writeDataPoint({
    indexes: [event.linkId],
    blobs: [
      event.slug,
      (cf?.country as string) || "",
      event.request.headers.get("user-agent") || "",
      event.request.headers.get("referer") || "",
      (cf?.city as string) || "",
      event.destinationUrl,
      (cf?.region as string) || "",
    ],
    doubles: [Date.now()],
  });
}

/**
 * Upsert the permanent daily aggregate in `link_stats` — the D1 half of
 * dual-storage stats (AE holds ~90-day detail; this survives forever and
 * feeds the maxClicks cap and lifetime totals).
 */
export async function upsertDailyStats(
  db: Database,
  linkId: string,
  date: string,
  clicks: number,
  uniqueClicks = 0
): Promise<void> {
  await db
    .insert(linkStats)
    .values({ linkId, date, clicks, uniqueClicks })
    .onConflictDoUpdate({
      target: [linkStats.linkId, linkStats.date],
      set: {
        clicks: sql`${linkStats.clicks} + ${clicks}`,
        uniqueClicks: sql`${linkStats.uniqueClicks} + ${uniqueClicks}`,
      },
    });
}

// AE SQL API response types
type AERow = Record<string, string | number>;

interface AEResult {
  data: AERow[];
}

// WARNING: The AE SQL API does not support parameterized queries.
// Callers MUST sanitize any user-controlled values before interpolating into the query string.
export async function queryAnalyticsEngine(
  accountId: string,
  apiToken: string,
  query: string
): Promise<AEResult> {
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
