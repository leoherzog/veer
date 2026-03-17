import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import app from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx } from "../helpers";
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
      });

      const res = await app.request("/kv-inactive", {}, env, mockExecutionCtx());

      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });
  });

  // ── Click stats (D1 link_stats table) ────────────────────────────────
  // Note: waitUntil is mocked, so background tasks (incrementClickStats)
  // won't actually run. We test incrementClickStats directly in unit tests.

  describe("Click stats", () => {
    it("redirect succeeds even though waitUntil is mocked", async () => {
      await createTestLink(env.DB, {
        slug: "stats-redirect",
        destinationUrl: "https://example.com/stats",
        userId: auth.user.id,
      });

      const res = await app.request("/stats-redirect", {}, env, mockExecutionCtx());
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/stats");
    });
  });
});
