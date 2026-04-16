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

// AE SQL API response types
type AERow = Record<string, string | number>;

interface AEMeta {
  name: string;
  type: string;
}

interface AEResult {
  data: AERow[];
  meta: AEMeta[];
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
  const result = await resp.json<{ success: boolean; errors?: { message: string }[]; data?: AERow[]; meta?: AEMeta[] }>();
  if (!result.success) {
    const msg = result.errors?.[0]?.message ?? "Analytics Engine query failed";
    throw new Error(msg);
  }
  return { data: result.data ?? [], meta: result.meta ?? [] };
}
