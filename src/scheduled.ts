import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "./db";
import { links } from "./db/schema";
import { isDemoMode } from "./lib/branding";
import { DEMO_USER_ID } from "./lib/demo";
import { upsertDailyStats, writeClickEvent, type Visitor } from "./services/analytics";

const SYNTHETIC_VISITORS: Visitor[] = [
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
  // An expired link takes no clicks, and synthetic clicks would carry a capped link past its cap.
  const clickable = await db
    .select({ id: links.id, slug: links.slug, destinationUrl: links.destinationUrl })
    .from(links)
    .where(and(
      eq(links.userId, DEMO_USER_ID),
      isNull(links.maxClicks),
      or(isNull(links.expiresAt), gt(links.expiresAt, new Date())),
    ));

  await Promise.all(clickable.map((link) => {
    const clickCount = Math.floor(Math.random() * 5) + 1;
    for (let i = 0; i < clickCount; i++) {
      writeClickEvent(env.ANALYTICS, {
        linkId: link.id,
        slug: link.slug,
        destinationUrl: link.destinationUrl,
        ...pick(SYNTHETIC_VISITORS),
      });
    }
    return upsertDailyStats(db, link.id, clickCount);
  }));
}
