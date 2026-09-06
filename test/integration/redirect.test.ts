import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx, trackedExecutionCtx } from "../helpers";
import { setCachedRedirect } from "../../src/services/kv-cache";

describe("Redirect engine – GET /:slug", () => {
  let auth: Awaited<ReturnType<typeof setupAuth>>;

  beforeAll(async () => {
    auth = await setupAuth(env);
  });

  // ── D1 fallback (no KV cache) ────────────────────────────────────────

  describe("D1 fallback (no KV cache)", () => {
    it("redirects active link with 302 by default", async () => {
      await createTestLink(env.DB, {
        slug: "d1-302",
        destinationUrl: "https://example.com/target-302",
        userId: auth.user.id,
      });

      const res = await app.request("/d1-302", {}, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/target-302");
    });

    it("redirects active link with 301 when redirectType is 301", async () => {
      await createTestLink(env.DB, {
        slug: "d1-301",
        destinationUrl: "https://example.com/target-301",
        redirectType: 301,
        userId: auth.user.id,
      });

      const res = await app.request("/d1-301", {}, env, mockExecutionCtx());

      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://example.com/target-301");
    });

    it("non-existent slug falls through (not a redirect)", async () => {
      const res = await app.request("/no-such-slug-xyz", {}, env, mockExecutionCtx());

      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });

    it("inactive link falls through (not a redirect)", async () => {
      await createTestLink(env.DB, {
        slug: "d1-inactive",
        destinationUrl: "https://example.com/inactive",
        isActive: false,
        userId: auth.user.id,
      });

      const res = await app.request("/d1-inactive", {}, env, mockExecutionCtx());

      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });
  });

  // ── KV cache hit ─────────────────────────────────────────────────────

  describe("KV cache hit", () => {
    it("redirects when KV has a cached active entry", async () => {
      await setCachedRedirect(env.KV, "kv-hit", {
        url: "https://example.com/from-kv",
        redirectType: 302,
        linkId: "kv-link-1",
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
        domainHostname: null,
      });

      const res = await app.request("/kv-hit", {}, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/from-kv");
    });

    it("inactive KV entry falls through (not a redirect)", async () => {
      await setCachedRedirect(env.KV, "kv-inactive", {
        url: "https://example.com/inactive-kv",
        redirectType: 302,
        linkId: "kv-link-2",
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
        domainHostname: null,
      });

      const res = await app.request("/kv-inactive", {}, env, mockExecutionCtx());

      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });
  });

  // ── Daily aggregate (link_stats) ─────────────────────────────────────

  // ── Slug normalization ───────────────────────────────────────────────

  describe("Slug normalization", () => {
    it("resolves a slug case-insensitively", async () => {
      await createTestLink(env.DB, {
        slug: "case-fold",
        destinationUrl: "https://example.com/case-fold",
        userId: auth.user.id,
      });

      for (const path of ["/case-fold", "/Case-Fold", "/CASE-FOLD"]) {
        const res = await app.request(path, {}, env, mockExecutionCtx());
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("https://example.com/case-fold");
      }
    });

    it("resolves a case variant through the KV cache too", async () => {
      const link = await createTestLink(env.DB, {
        slug: "cached-case",
        destinationUrl: "https://example.com/cached-case",
        userId: auth.user.id,
      });
      await setCachedRedirect(env.KV, "cached-case", {
        url: "https://example.com/from-cache",
        redirectType: 302,
        linkId: link.id,
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
        domainHostname: null,
      });

      const res = await app.request("/Cached-Case", {}, env, mockExecutionCtx());
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/from-cache");
    });

    it("resolves a percent-encoded emoji slug", async () => {
      await createTestLink(env.DB, {
        slug: "\u{1F389}",
        destinationUrl: "https://example.com/emoji",
        userId: auth.user.id,
      });

      const res = await app.request("/%F0%9F%8E%89", {}, env, mockExecutionCtx());
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/emoji");
    });
  });

  describe("Click stats aggregation", () => {
    it("upserts the daily link_stats row for each redirect", async () => {
      const link = await createTestLink(env.DB, {
        slug: "stats-agg",
        destinationUrl: "https://example.com/agg",
        userId: auth.user.id,
      });

      const first = await app.request("/stats-agg", {}, env, mockExecutionCtx());
      expect(first.status).toBe(302);
      const second = await app.request("/stats-agg", {}, env, mockExecutionCtx());
      expect(second.status).toBe(302);

      // The upsert runs via waitUntil, so poll until the background write lands
      await vi.waitFor(async () => {
        const row = await env.DB.prepare(
          "SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?"
        )
          .bind(link.id, new Date().toISOString().slice(0, 10))
          .first<{ clicks: number }>();
        expect(row?.clicks).toBe(2);
      });
    });
  });
});

describe("Redirect engine – caching headers", () => {
  let owner: Awaited<ReturnType<typeof setupAuth>>;

  beforeAll(async () => {
    owner = await setupAuth(env);
  });

  it("302 carries Cache-Control: private, no-store", async () => {
    await createTestLink(env.DB, { slug: "cc-302", destinationUrl: "https://example.com/cc-302", userId: owner.user.id });

    const res = await app.request("/cc-302", {}, env, mockExecutionCtx());

    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("301 is left cacheable", async () => {
    await createTestLink(env.DB, { slug: "cc-301", destinationUrl: "https://example.com/cc-301", redirectType: 301, userId: owner.user.id });

    const res = await app.request("/cc-301", {}, env, mockExecutionCtx());

    expect(res.status).toBe(301);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

describe("Redirect engine – HEAD requests", () => {
  let owner: Awaited<ReturnType<typeof setupAuth>>;

  beforeAll(async () => {
    owner = await setupAuth(env);
  });

  it("HEAD redirects without recording a click", async () => {
    const link = await createTestLink(env.DB, { slug: "head-slug", destinationUrl: "https://example.com/head", userId: owner.user.id });
    const today = new Date().toISOString().slice(0, 10);

    const head = trackedExecutionCtx();
    const res = await app.request("/head-slug", { method: "HEAD" }, env, head.ctx);
    await head.settled();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/head");

    const row = await env.DB.prepare("SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?")
      .bind(link.id, today)
      .first<{ clicks: number }>();
    expect(row).toBeNull();

    // The same slug over GET still counts, so the guard is on the method only.
    const res2 = await app.request("/head-slug", {}, env, mockExecutionCtx());
    expect(res2.status).toBe(302);
    await vi.waitFor(async () => {
      const after = await env.DB.prepare("SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?")
        .bind(link.id, today)
        .first<{ clicks: number }>();
      expect(after?.clicks).toBe(1);
    });
  });
});

describe("Redirect engine – reserved slugs", () => {
  let owner: Awaited<ReturnType<typeof setupAuth>>;

  beforeAll(async () => {
    owner = await setupAuth(env);
  });

  it("falls through without a KV or D1 lookup even when a row and cache entry exist", async () => {
    // validateSlug rejects reserved slugs, so these can only be planted directly.
    await createTestLink(env.DB, { slug: "settings", destinationUrl: "https://example.com/should-not-redirect", userId: owner.user.id });
    await setCachedRedirect(env.KV, "settings", {
      url: "https://example.com/should-not-redirect-cached",
      redirectType: 302,
      linkId: "reserved-link",
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
      domainHostname: null,
    });

    const res = await app.request("/settings", {}, env, mockExecutionCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
  });
});

describe("Trailing slash", () => {
  let owner: Awaited<ReturnType<typeof setupAuth>>;

  beforeAll(async () => {
    owner = await setupAuth(env);
  });

  it("301s /:slug/ to the canonical /:slug", async () => {
    await createTestLink(env.DB, { slug: "ts-slug", destinationUrl: "https://example.com/ts", userId: owner.user.id });

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
