import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedRedirect,
  setCachedRedirect,
  deleteCachedRedirect,
} from "../../src/services/kv-cache";

describe("KV cache service", () => {
  const kv = env.KV;

  const sampleRedirect = {
    url: "https://example.com/target",
    redirectType: 301,
    linkId: "link-abc",
    isActive: true,
    expiresAt: null,
    maxClicks: null,
    hasPassword: false,
    isInternal: false,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    paramForwarding: false,
    targets: null,
  };

  it("getCachedRedirect returns null for missing key", async () => {
    const result = await getCachedRedirect(kv, "nonexistent");
    expect(result).toBeNull();
  });

  it("setCachedRedirect + getCachedRedirect roundtrip works", async () => {
    await setCachedRedirect(kv, "my-slug", sampleRedirect);
    const result = await getCachedRedirect(kv, "my-slug");
    expect(result).toEqual(sampleRedirect);
  });

  it("deleteCachedRedirect removes the entry", async () => {
    await setCachedRedirect(kv, "to-delete", sampleRedirect);
    await deleteCachedRedirect(kv, "to-delete");
    const result = await getCachedRedirect(kv, "to-delete");
    expect(result).toBeNull();
  });

  it("stored data preserves all fields correctly", async () => {
    const data = {
      url: "https://example.com/full-test",
      redirectType: 302,
      linkId: "link-xyz",
      isActive: false,
      expiresAt: null,
      maxClicks: null,
      hasPassword: false,
      isInternal: false,
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
      paramForwarding: false,
      targets: null,
    };
    await setCachedRedirect(kv, "full-fields", data);
    const result = await getCachedRedirect(kv, "full-fields");
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://example.com/full-test");
    expect(result!.redirectType).toBe(302);
    expect(result!.linkId).toBe("link-xyz");
    expect(result!.isActive).toBe(false);
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
});
