import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx, cachedRedirect, isoDaysAgo } from "../helpers";
import { setCachedRedirect } from "../../src/services/kv-cache";

let owner: Awaited<ReturnType<typeof setupAuth>>;

beforeAll(async () => {
  owner = await setupAuth();
});

describe("Redirect engine – GET /:slug", () => {
  // ── D1 fallback (no KV cache) ────────────────────────────────────────

  describe("D1 fallback (no KV cache)", () => {
    it("redirects active link with 302 by default", async () => {
      await createTestLink({
        slug: "d1-302",
        destinationUrl: "https://example.com/target-302",
        userId: owner.user.id,
      });

      const res = await app.request("/d1-302", {}, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/target-302");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    });

    it("redirects active link with 301 when redirectType is 301", async () => {
      await createTestLink({
        slug: "d1-301",
        destinationUrl: "https://example.com/target-301",
        redirectType: 301,
        userId: owner.user.id,
      });

      const res = await app.request("/d1-301", {}, env, mockExecutionCtx());

      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://example.com/target-301");
      expect(res.headers.get("Cache-Control")).toBeNull();
    });

    it("non-existent slug falls through (not a redirect)", async () => {
      const res = await app.request("/no-such-slug-xyz", {}, env, mockExecutionCtx());

      expect(res.headers.get("Location")).toBeNull();
    });

    it("inactive link falls through (not a redirect)", async () => {
      await createTestLink({
        slug: "d1-inactive",
        destinationUrl: "https://example.com/inactive",
        isActive: false,
        userId: owner.user.id,
      });

      const res = await app.request("/d1-inactive", {}, env, mockExecutionCtx());

      expect(res.headers.get("Location")).toBeNull();
    });
  });

  // ── KV cache hit ─────────────────────────────────────────────────────

  describe("KV cache hit", () => {
    it("redirects when KV has a cached active entry", async () => {
      await setCachedRedirect(env.KV, "kv-hit", cachedRedirect({ url: "https://example.com/from-kv", linkId: "kv-link-1" }));

      const res = await app.request("/kv-hit", {}, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/from-kv");
    });

    it("inactive KV entry falls through (not a redirect)", async () => {
      await setCachedRedirect(env.KV, "kv-inactive", cachedRedirect({
        url: "https://example.com/inactive-kv",
        linkId: "kv-link-2",
        isActive: false,
      }));

      const res = await app.request("/kv-inactive", {}, env, mockExecutionCtx());

      expect(res.headers.get("Location")).toBeNull();
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
        const res = await app.request(path, {}, env, mockExecutionCtx());
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

      const res = await app.request("/Cached-Case", {}, env, mockExecutionCtx());
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/from-cache");
    });

    it("resolves a percent-encoded emoji slug", async () => {
      await createTestLink({
        slug: "\u{1F389}",
        destinationUrl: "https://example.com/emoji",
        userId: owner.user.id,
      });

      const res = await app.request("/%F0%9F%8E%89", {}, env, mockExecutionCtx());
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
      const first = await app.request("/stats-agg", {}, env, ctx);
      expect(first.status).toBe(302);
      const second = await app.request("/stats-agg", {}, env, ctx);
      expect(second.status).toBe(302);
      await waitOnExecutionContext(ctx);

      const row = await env.DB.prepare("SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?")
        .bind(link.id, isoDaysAgo(0))
        .first<{ clicks: number }>();
      expect(row?.clicks).toBe(2);
    });
  });
});

describe("Redirect engine – HEAD requests", () => {
  it("HEAD redirects without recording a click", async () => {
    const link = await createTestLink({ slug: "head-slug", destinationUrl: "https://example.com/head", userId: owner.user.id });
    const today = isoDaysAgo(0);

    const headCtx = createExecutionContext();
    const res = await app.request("/head-slug", { method: "HEAD" }, env, headCtx);
    await waitOnExecutionContext(headCtx);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/head");

    const row = await env.DB.prepare("SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?")
      .bind(link.id, today)
      .first<{ clicks: number }>();
    expect(row).toBeNull();

    // The same slug over GET still counts, so the guard is on the method only.
    const getCtx = createExecutionContext();
    const res2 = await app.request("/head-slug", {}, env, getCtx);
    await waitOnExecutionContext(getCtx);
    expect(res2.status).toBe(302);
    const after = await env.DB.prepare("SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?")
      .bind(link.id, today)
      .first<{ clicks: number }>();
    expect(after?.clicks).toBe(1);
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

    const res = await app.request("/settings", {}, env, mockExecutionCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
  });
});

describe("Trailing slash", () => {
  it("301s /:slug/ to the canonical /:slug", async () => {
    await createTestLink({ slug: "ts-slug", destinationUrl: "https://example.com/ts", userId: owner.user.id });

    const res = await app.request("/ts-slug/", {}, env, mockExecutionCtx());

    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("Location")!).pathname).toBe("/ts-slug");
  });

  it("301s an unknown path with a trailing slash rather than serving the SPA", async () => {
    const res = await app.request("/no-such-slug/", {}, env, mockExecutionCtx());

    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("Location")!).pathname).toBe("/no-such-slug");
  });

  it("preserves the query string", async () => {
    const res = await app.request("/ts-slug/?utm_source=x", {}, env, mockExecutionCtx());

    const location = new URL(res.headers.get("Location")!);
    expect(location.pathname).toBe("/ts-slug");
    expect(location.search).toBe("?utm_source=x");
  });

  it("leaves / alone", async () => {
    const res = await app.request("/", {}, env, mockExecutionCtx());

    expect(res.status).not.toBe(301);
  });

  it("leaves non-GET requests alone", async () => {
    const res = await app.request("/ts-slug/", { method: "POST" }, env, mockExecutionCtx());

    expect(res.status).not.toBe(301);
  });
});
