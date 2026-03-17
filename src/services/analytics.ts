import type { Database } from "../db";
import { linkStats } from "../db/schema";
import { sql } from "drizzle-orm";

interface ClickEvent {
  linkId: string;
  slug: string;
  destinationUrl: string;
  request: Request;
}

export function writeClickEvent(analytics: AnalyticsEngineDataset, event: ClickEvent): void {
  const cf = (event.request as Request & { cf?: IncomingRequestCfProperties }).cf;
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

// WARNING: The AE SQL API does not support parameterized queries.
// Callers MUST sanitize any user-controlled values before interpolating into the query string.
export async function queryAnalyticsEngine(
  accountId: string,
  apiToken: string,
  query: string
): Promise<{ data: any[]; meta: any }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
    body: query,
  });
  const result = await resp.json<{ success: boolean; errors?: { message: string }[]; data?: any[]; meta?: any }>();
  if (!result.success) {
    const msg = result.errors?.[0]?.message ?? "Analytics Engine query failed";
    throw new Error(msg);
  }
  return { data: result.data ?? [], meta: result.meta ?? {} };
}

export async function incrementClickStats(db: Database, linkId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db
    .insert(linkStats)
    // TODO: uniqueClicks tracking requires IP-hash or cookie-based deduplication (future milestone)
    .values({ linkId, date: today, clicks: 1, uniqueClicks: 0 })
    .onConflictDoUpdate({
      target: [linkStats.linkId, linkStats.date],
      set: { clicks: sql`${linkStats.clicks} + 1` },
    });
}
