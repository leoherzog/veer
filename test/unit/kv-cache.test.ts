import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  getCachedRedirect,
  setCachedRedirect,
  deleteCachedRedirect,
} from "../../src/services/kv-cache";
import { cachedRedirect } from "../helpers";

describe("KV cache service", () => {
  const kv = env.KV;

  const sampleRedirect = cachedRedirect({ url: "https://example.com/target", redirectType: 301, linkId: "link-abc" });

  it("getCachedRedirect returns null for missing key", async () => {
    const result = await getCachedRedirect(kv, "nonexistent");
    expect(result).toBeNull();
  });

  it("setCachedRedirect + getCachedRedirect roundtrip works", async () => {
    await setCachedRedirect(kv, "my-slug", sampleRedirect);
    const result = await getCachedRedirect(kv, "my-slug");
    expect(result).toEqual(sampleRedirect);
  });

  it("multiple slugs coexist independently", async () => {
    const dataA = { ...sampleRedirect, linkId: "link-a", url: "https://a.com" };
    const dataB = { ...sampleRedirect, linkId: "link-b", url: "https://b.com" };

    await setCachedRedirect(kv, "slug-a", dataA);
    await setCachedRedirect(kv, "slug-b", dataB);

    const resultA = await getCachedRedirect(kv, "slug-a");
    const resultB = await getCachedRedirect(kv, "slug-b");

    expect(resultA).toEqual(dataA);
    expect(resultB).toEqual(dataB);

    // Deleting one does not affect the other
    await deleteCachedRedirect(kv, "slug-a");
    expect(await getCachedRedirect(kv, "slug-a")).toBeNull();
    expect(await getCachedRedirect(kv, "slug-b")).toEqual(dataB);
  });

  it("writes each entry with a 7-day TTL", async () => {
    const before = Math.floor(Date.now() / 1000);
    await setCachedRedirect(kv, "ttl-slug", sampleRedirect, "ttl.example.com");
    const after = Math.ceil(Date.now() / 1000);

    const { keys } = await kv.list({ prefix: "ttl.example.com:" });
    expect(keys.map((k) => k.name)).toEqual(["ttl.example.com:ttl-slug"]);
    expect(keys[0].expiration).toBeGreaterThanOrEqual(before + 7 * 86_400);
    expect(keys[0].expiration).toBeLessThanOrEqual(after + 7 * 86_400);
  });

  describe("domain-scoped keys", () => {
    it("domain-scoped key is isolated from default key", async () => {
      const domainData = { ...sampleRedirect, linkId: "link-domain" };
      const defaultData = { ...sampleRedirect, linkId: "link-default" };

      await setCachedRedirect(kv, "shared-slug", domainData, "brand.co");
      await setCachedRedirect(kv, "shared-slug", defaultData);

      const domainResult = await getCachedRedirect(kv, "shared-slug", "brand.co");
      const defaultResult = await getCachedRedirect(kv, "shared-slug");

      expect(domainResult?.linkId).toBe("link-domain");
      expect(defaultResult?.linkId).toBe("link-default");
    });

    it("deletes domain-scoped key without affecting default", async () => {
      const domainData = { ...sampleRedirect, linkId: "link-brand" };
      const defaultData = { ...sampleRedirect };

      await setCachedRedirect(kv, "del-test", domainData, "brand.co");
      await setCachedRedirect(kv, "del-test", defaultData);

      await deleteCachedRedirect(kv, "del-test", "brand.co");

      expect(await getCachedRedirect(kv, "del-test", "brand.co")).toBeNull();
      expect(await getCachedRedirect(kv, "del-test")).toEqual(defaultData);
    });
  });
});
