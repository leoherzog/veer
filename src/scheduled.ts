import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { links, linkStats } from "./db/schema";
import { isDemoMode } from "./lib/branding";
import { DEMO_USER_ID } from "./lib/demo";

const SYNTHETIC_VISITORS: Array<{
  country: string;
  city: string;
  region: string;
  userAgent: string;
  referer: string;
}> = [
  { country: "US", city: "San Francisco", region: "California", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", referer: "https://news.ycombinator.com/" },
  { country: "US", city: "New York", region: "New York", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", referer: "https://twitter.com/" },
  { country: "GB", city: "London", region: "England", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", referer: "" },
  { country: "DE", city: "Berlin", region: "Berlin", userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0", referer: "https://github.com/" },
  { country: "JP", city: "Tokyo", region: "Tokyo", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", referer: "https://www.google.com/" },
  { country: "CA", city: "Toronto", region: "Ontario", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", referer: "https://www.linkedin.com/" },
  { country: "AU", city: "Sydney", region: "New South Wales", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", referer: "" },
  { country: "FR", city: "Paris", region: "Île-de-France", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", referer: "https://www.reddit.com/" },
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export async function scheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (!isDemoMode(env)) return;

  const db = getDb(env.DB);
  const seededLinks = await db
    .select({ id: links.id, slug: links.slug, destinationUrl: links.destinationUrl })
    .from(links)
    .where(eq(links.userId, DEMO_USER_ID));

  if (seededLinks.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);

  for (const link of seededLinks) {
    const clickCount = Math.floor(Math.random() * 5) + 1;
    // 60–85% unique, plausible vs an always-equal count.
    const uniqueCount = Math.max(1, Math.round(clickCount * (0.6 + Math.random() * 0.25)));
    for (let i = 0; i < clickCount; i++) {
      const visitor = pick(SYNTHETIC_VISITORS);
      env.ANALYTICS.writeDataPoint({
        indexes: [link.id],
        blobs: [
          link.slug,
          visitor.country,
          visitor.userAgent,
          visitor.referer,
          visitor.city,
          link.destinationUrl,
          visitor.region,
        ],
        doubles: [Date.now()],
      });
    }

    await db
      .insert(linkStats)
      .values({
        linkId: link.id,
        date: today,
        clicks: clickCount,
        uniqueClicks: uniqueCount,
      })
      .onConflictDoUpdate({
        target: [linkStats.linkId, linkStats.date],
        set: {
          clicks: sql`${linkStats.clicks} + ${clickCount}`,
          uniqueClicks: sql`${linkStats.uniqueClicks} + ${uniqueCount}`,
        },
      });
  }
}
