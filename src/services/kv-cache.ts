export interface CachedTarget {
  type: "geo" | "device" | "ab";
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

/** Shape of a links row (with optional resolved targets) needed to build a CachedRedirect. */
export interface CachedRedirectSource {
  id: string;
  destinationUrl: string;
  redirectType: number;
  isActive: boolean | number;
  expiresAt: Date | string | number | null;
  maxClicks: number | null;
  password: string | null;
  isInternal: boolean | number | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  paramForwarding: boolean | number | null;
  domainHostname?: string | null;
}

/** Map a links row (+ resolved targets) into the CachedRedirect KV shape. */
export function toCachedRedirect(link: CachedRedirectSource, targets: CachedTarget[] | null): CachedRedirect {
  let expiresAt: number | null = null;
  if (link.expiresAt != null) {
    const d = link.expiresAt instanceof Date ? link.expiresAt : new Date(link.expiresAt);
    expiresAt = Math.floor(d.getTime() / 1000);
  }

  return {
    url: link.destinationUrl,
    redirectType: link.redirectType,
    linkId: link.id,
    isActive: !!link.isActive,
    expiresAt,
    maxClicks: link.maxClicks ?? null,
    hasPassword: !!link.password,
    isInternal: !!link.isInternal,
    ogTitle: link.ogTitle ?? null,
    ogDescription: link.ogDescription ?? null,
    ogImage: link.ogImage ?? null,
    paramForwarding: !!link.paramForwarding,
    targets,
    domainHostname: link.domainHostname ?? null,
  };
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
