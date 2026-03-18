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
}

export async function getCachedRedirect(kv: KVNamespace, slug: string): Promise<CachedRedirect | null> {
  const value = await kv.get(slug, { type: "json", cacheTtl: 30 });
  return value as CachedRedirect | null;
}

export async function setCachedRedirect(kv: KVNamespace, slug: string, data: CachedRedirect): Promise<void> {
  await kv.put(slug, JSON.stringify(data), { expirationTtl: 86400 });
}

export async function deleteCachedRedirect(kv: KVNamespace, slug: string): Promise<void> {
  await kv.delete(slug);
}
