import { eq } from "drizzle-orm";
import { linkTargets, type links } from "../db/schema";
import type { Database } from "../db";

export type CachedTarget = Pick<typeof linkTargets.$inferSelect, "type" | "matchValue" | "destinationUrl" | "priority">;

export interface CachedRedirect {
  url: string;
  redirectType: number;
  linkId: string;
  isActive: boolean;
  expiresAt: number | null;
  maxClicks: number | null;
  hasPassword: boolean;
  isInternal: boolean;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  paramForwarding: boolean;
  targets: CachedTarget[] | null;
}

/** The links columns a CachedRedirect is built from. */
export type CachedRedirectSource = Pick<
  typeof links.$inferSelect,
  "id" | "destinationUrl" | "redirectType" | "isActive" | "expiresAt" | "maxClicks" | "password"
  | "isInternal" | "ogTitle" | "ogDescription" | "ogImage" | "paramForwarding"
>;

/** Map a links row and its targets into the CachedRedirect KV shape. */
export function toCachedRedirect(link: CachedRedirectSource, targets: CachedTarget[] | null): CachedRedirect {
  return {
    url: link.destinationUrl,
    redirectType: link.redirectType,
    linkId: link.id,
    isActive: link.isActive,
    expiresAt: link.expiresAt ? Math.floor(link.expiresAt.getTime() / 1000) : null,
    maxClicks: link.maxClicks,
    hasPassword: !!link.password,
    isInternal: link.isInternal,
    ogTitle: link.ogTitle,
    ogDescription: link.ogDescription,
    ogImage: link.ogImage,
    paramForwarding: link.paramForwarding,
    targets,
  };
}

/** Read a link's targeting rules from D1 and build its CachedRedirect. */
export async function loadCachedRedirect(db: Database, link: CachedRedirectSource): Promise<CachedRedirect> {
  const targets = await db.select({
    type: linkTargets.type,
    matchValue: linkTargets.matchValue,
    destinationUrl: linkTargets.destinationUrl,
    priority: linkTargets.priority,
  }).from(linkTargets).where(eq(linkTargets.linkId, link.id));
  return toCachedRedirect(link, targets.length ? targets : null);
}

/** Build a KV key: `hostname:slug` for custom domains, bare `slug` for default. */
function kvKey(slug: string, hostname?: string | null): string {
  return hostname ? `${hostname}:${slug}` : slug;
}

export async function getCachedRedirect(kv: KVNamespace, slug: string, hostname?: string | null): Promise<CachedRedirect | null> {
  return kv.get<CachedRedirect>(kvKey(slug, hostname), { type: "json", cacheTtl: 30 });
}

/**
 * Cache TTL is a backstop, not the invalidation mechanism — every mutation path
 * calls setCachedRedirect/deleteCachedRedirect explicitly, so entries are never
 * stale-by-expiry in normal operation. It is deliberately long because each
 * refill costs a KV write, and the free tier allows only 1,000 writes/day: a
 * 24h TTL caps you at ~1,000 actively-hit slugs, a 7d TTL at ~7,000.
 */
const CACHE_TTL_SECONDS = 604800; // 7 days

export async function setCachedRedirect(kv: KVNamespace, slug: string, data: CachedRedirect, hostname?: string | null): Promise<void> {
  await kv.put(kvKey(slug, hostname), JSON.stringify(data), { expirationTtl: CACHE_TTL_SECONDS });
}

export async function deleteCachedRedirect(kv: KVNamespace, slug: string, hostname?: string | null): Promise<void> {
  await kv.delete(kvKey(slug, hostname));
}
