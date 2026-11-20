import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { setupAuth, createTestLink, cachedRedirect, api, expectSpaShell, totalClicks } from "../helpers";
import { setCachedRedirect } from "../../src/services/kv-cache";

let owner: Awaited<ReturnType<typeof setupAuth>>;

beforeAll(async () => {
  owner = await setupAuth();
});

describe("Redirect engine – GET /:slug", () => {
  // ── D1 fallback (no KV cache) ────────────────────────────────────────

  describe("D1 fallback (no KV cache)", () => {
    it("redirects a link with 302 by default", async () => {
      await createTestLink({
        slug: "d1-302",
        destinationUrl: "https://example.com/target-302",
        userId: owner.user.id,
      });

      const res = await api("GET", "/d1-302");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/target-302");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    });

    it("redirects a link with 301 when redirectType is 301", async () => {
      await createTestLink({
        slug: "d1-301",
        destinationUrl: "https://example.com/target-301",
        redirectType: 301,
        userId: owner.user.id,
      });

      const res = await api("GET", "/d1-301");

      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://example.com/target-301");
      expect(res.headers.get("Cache-Control")).toBeNull();
    });

    it("non-existent slug falls through to the SPA", async () => {
      await expectSpaShell(await api("GET", "/no-such-slug-xyz"));
    });
  });

  // ── Slug normalization ───────────────────────────────────────────────

  describe("Slug normalization", () => {
    it("resolves a slug case-insensitively", async () => {
      await createTestLink({
        slug: "case-fold",
        destinationUrl: "https://example.com/case-fold",
        userId: owner.user.id,
      });

      for (const path of ["/case-fold", "/Case-Fold", "/CASE-FOLD"]) {
        const res = await api("GET", path);
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("https://example.com/case-fold");
      }
    });

    it("resolves a case variant through the KV cache too", async () => {
      const link = await createTestLink({
        slug: "cached-case",
        destinationUrl: "https://example.com/cached-case",
        userId: owner.user.id,
      });
      await setCachedRedirect(env.KV, "cached-case", cachedRedirect({ url: "https://example.com/from-cache", linkId: link.id }));

      const res = await api("GET", "/Cached-Case");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/from-cache");
    });

    it("resolves a percent-encoded emoji slug", async () => {
      await createTestLink({
        slug: "\u{1F389}",
        destinationUrl: "https://example.com/emoji",
        userId: owner.user.id,
      });

      const res = await api("GET", "/%F0%9F%8E%89");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/emoji");
    });
  });

  // ── Daily aggregate (link_stats) ─────────────────────────────────────

  describe("Click stats aggregation", () => {
    it("upserts the daily link_stats row for each redirect", async () => {
      const link = await createTestLink({
        slug: "stats-agg",
        destinationUrl: "https://example.com/agg",
        userId: owner.user.id,
      });

      // The upsert runs in waitUntil.
      const ctx = createExecutionContext();
      const first = await api("GET", "/stats-agg", { ctx });
      expect(first.status).toBe(302);
      const second = await api("GET", "/stats-agg", { ctx });
      expect(second.status).toBe(302);
      await waitOnExecutionContext(ctx);

      expect(await totalClicks(link.id)).toBe(2);
    });
  });
});

describe("Redirect engine – HEAD requests", () => {
  it("HEAD redirects without recording a click", async () => {
    const link = await createTestLink({ slug: "head-slug", destinationUrl: "https://example.com/head", userId: owner.user.id });

    const headCtx = createExecutionContext();
    const res = await api("HEAD", "/head-slug", { ctx: headCtx });
    await waitOnExecutionContext(headCtx);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/head");
    expect(await totalClicks(link.id)).toBe(0);

    // The same slug over GET still counts, so the guard is on the method only.
    const getCtx = createExecutionContext();
    const res2 = await api("GET", "/head-slug", { ctx: getCtx });
    await waitOnExecutionContext(getCtx);
    expect(res2.status).toBe(302);
    expect(await totalClicks(link.id)).toBe(1);
  });
});

describe("Redirect engine – reserved slugs", () => {
  it("falls through without a KV or D1 lookup even when a row and cache entry exist", async () => {
    // validateSlug rejects reserved slugs, so these can only be planted directly.
    await createTestLink({ slug: "settings", destinationUrl: "https://example.com/should-not-redirect", userId: owner.user.id });
    await setCachedRedirect(env.KV, "settings", cachedRedirect({
      url: "https://example.com/should-not-redirect-cached",
      linkId: "reserved-link",
    }));

    await expectSpaShell(await api("GET", "/settings"));
  });
});

describe("Trailing slash", () => {
  it("301s a path with a trailing slash to the canonical path", async () => {
    const res = await api("GET", "/no-such-slug/");

    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("Location")!).pathname).toBe("/no-such-slug");
  });

  it("preserves the query string", async () => {
    const res = await api("GET", "/ts-slug/?utm_source=x");

    const location = new URL(res.headers.get("Location")!);
    expect(location.pathname).toBe("/ts-slug");
    expect(location.search).toBe("?utm_source=x");
  });

  it("does not redirect a POST, which the asset binding answers with 405", async () => {
    const res = await api("POST", "/ts-slug/");

    expect(res.status).toBe(405);
    expect(res.headers.get("Location")).toBeNull();
  });
});
