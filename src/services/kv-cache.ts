export interface CachedTarget {
  type: "geo" | "device";
  matchValue: string;
  destinationUrl: string;
  priority: number;
}

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
  domainHostname: string | null;
}

/** Build a KV key: `hostname:slug` for custom domains, bare `slug` for default. */
function kvKey(slug: string, hostname?: string | null): string {
  return hostname ? `${hostname}:${slug}` : slug;
}

export async function getCachedRedirect(kv: KVNamespace, slug: string, hostname?: string | null): Promise<CachedRedirect | null> {
  const value = await kv.get(kvKey(slug, hostname), { type: "json", cacheTtl: 30 });
  return value as CachedRedirect | null;
}

export async function setCachedRedirect(kv: KVNamespace, slug: string, data: CachedRedirect, hostname?: string | null): Promise<void> {
  await kv.put(kvKey(slug, hostname), JSON.stringify(data), { expirationTtl: 86400 });
}

export async function deleteCachedRedirect(kv: KVNamespace, slug: string, hostname?: string | null): Promise<void> {
  await kv.delete(kvKey(slug, hostname));
}
