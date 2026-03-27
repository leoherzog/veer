import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import app from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx, apiRequest, insertClickStat, type JsonBody } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(method: string, path: string, opts: { headers?: Record<string, string>; body?: JsonBody } = {}) {
  return apiRequest(app, method, path, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reports API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth(env);
    headers = auth.headers;
    userId = auth.user.id;
  });

  // -------------------------------------------------------------------------
  // POST /api/reports/:linkId — create report
  // -------------------------------------------------------------------------
  describe("POST /api/reports/:linkId", () => {
    it("creates a report for the user's own link", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-create-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { token: string; isEnabled: boolean; createdAt: unknown; linkId: string } };
      expect(json.data.token).toMatch(/^rpt_/);
      expect(json.data.isEnabled).toBe(true);
      expect(json.data.createdAt).toBeTruthy();
      expect(json.data.linkId).toBe(link.id);
    });

    it("returns existing report (idempotent) when called again", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-idem-${crypto.randomUUID().slice(0,8)}`, userId });

      const res1 = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res1.status).toBe(201);
      const json1 = await res1.json() as { data: { token: string } };

      const res2 = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res2.status).toBe(200);
      const json2 = await res2.json() as { data: { token: string } };

      expect(json2.data.token).toBe(json1.data.token);
    });

    it("returns 404 for a non-existent link", async () => {
      const res = await api("POST", "/api/reports/nonexistent-link-id", { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a link owned by another user", async () => {
      const otherAuth = await setupAuth(env, { email: `rpt-other-${Date.now()}@test.com` });
      const link = await createTestLink(env.DB, {
        slug: `rpt-other-${crypto.randomUUID().slice(0,8)}`,
        userId: otherAuth.user.id,
      });

      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 401 for unauthenticated request", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-unauth-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("POST", `/api/reports/${link.id}`, {
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/reports/:linkId — toggle isEnabled
  // -------------------------------------------------------------------------
  describe("PUT /api/reports/:linkId", () => {
    it("toggles isEnabled from true to false", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-toggle1-${crypto.randomUUID().slice(0,8)}`, userId });
      // Create report first
      await api("POST", `/api/reports/${link.id}`, { headers });

      const res = await api("PUT", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { isEnabled: boolean } };
      expect(json.data.isEnabled).toBe(false);
    });

    it("toggles isEnabled from false back to true", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-toggle2-${crypto.randomUUID().slice(0,8)}`, userId });
      await api("POST", `/api/reports/${link.id}`, { headers });

      // First toggle: true → false
      await api("PUT", `/api/reports/${link.id}`, { headers });

      // Second toggle: false → true
      const res = await api("PUT", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { isEnabled: boolean } };
      expect(json.data.isEnabled).toBe(true);
    });

    it("returns 404 if no report exists for the link", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-noreport-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("PUT", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 401 for unauthenticated request", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-put-unauth-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("PUT", `/api/reports/${link.id}`, {
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/public-report/:token — public report viewer
  // -------------------------------------------------------------------------
  describe("GET /api/public-report/:token", () => {
    it("returns stats for a valid enabled token", async () => {
      const link = await createTestLink(env.DB, {
        slug: `rpt-pub-${crypto.randomUUID().slice(0,8)}`,
        userId,
        title: "Public Test Link",
      });
      await insertClickStat(env.DB, link.id, 10, "2026-03-20");
      await insertClickStat(env.DB, link.id, 5, "2026-03-21");

      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      const createJson = await createRes.json() as { data: { token: string } };
      const token = createJson.data.token;

      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: {
          slug: string;
          title: string | null;
          totalClicks: number;
          timeseries: { labels: string[]; clicks: number[] };
        };
      };
      expect(json.data.slug).toBe(link.slug);
      expect(json.data.title).toBe("Public Test Link");
      expect(json.data.totalClicks).toBe(15);
      expect(Array.isArray(json.data.timeseries.labels)).toBe(true);
      expect(Array.isArray(json.data.timeseries.clicks)).toBe(true);
    });

    it("returns 404 for an invalid token", async () => {
      const res = await api("GET", "/api/public-report/rpt_invalidtoken00000000000000000");
      expect(res.status).toBe(404);
    });

    it("returns 404 when link is deactivated", async () => {
      const link = await createTestLink(env.DB, {
        slug: `rpt-deact-${crypto.randomUUID().slice(0, 8)}`,
        userId,
        title: "Deactivated Link",
      });
      await insertClickStat(env.DB, link.id, 7, "2026-03-22");

      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(createRes.status).toBe(201);
      const createJson = await createRes.json() as { data: { token: string } };
      const token = createJson.data.token;

      // Public report works while link is active
      const okRes = await api("GET", `/api/public-report/${token}`);
      expect(okRes.status).toBe(200);

      // Deactivate the link directly in DB
      await env.DB.prepare("UPDATE links SET isActive = 0 WHERE id = ?")
        .bind(link.id).run();

      // Public report should now return 404
      const failRes = await api("GET", `/api/public-report/${token}`);
      expect(failRes.status).toBe(404);
    });

    it("returns 404 when report is disabled", async () => {
      const link = await createTestLink(env.DB, {
        slug: `rpt-disabled-${crypto.randomUUID().slice(0,8)}`,
        userId,
      });

      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      const createJson = await createRes.json() as { data: { token: string } };
      const token = createJson.data.token;

      // Disable the report
      await api("PUT", `/api/reports/${link.id}`, { headers });

      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(404);
    });

    it("rate limits by IP after 30 requests", async () => {
      const link = await createTestLink(env.DB, {
        slug: `rpt-rl-${crypto.randomUUID().slice(0, 8)}`,
        userId,
      });
      await insertClickStat(env.DB, link.id, 1, "2026-03-22");
      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      const createJson = await createRes.json() as { data: { token: string } };
      const token = createJson.data.token;

      // Pre-seed the KV counter to 29 so we only need 1 more to hit the limit
      const testIp = `10.0.0.${Date.now() % 256}`;
      const windowEpoch = Math.floor(Date.now() / 1000 / 60);
      const rlKey = `rl:pub:${testIp}:${windowEpoch}`;
      await env.KV.put(rlKey, "29", { expirationTtl: 120 });

      // Request 30 should succeed
      const res30 = await app.request(`/api/public-report/${token}`, {
        headers: { "cf-connecting-ip": testIp },
      }, env, mockExecutionCtx());
      expect(res30.status).toBe(200);

      // Request 31 should be rate limited
      const res31 = await app.request(`/api/public-report/${token}`, {
        headers: { "cf-connecting-ip": testIp },
      }, env, mockExecutionCtx());
      expect(res31.status).toBe(429);
    });

    it("uses 'unknown' as IP key when cf-connecting-ip is absent", async () => {
      const windowEpoch = Math.floor(Date.now() / 1000 / 60);
      const rlKey = `rl:pub:unknown:${windowEpoch}`;
      await env.KV.put(rlKey, "30", { expirationTtl: 120 });

      const link = await createTestLink(env.DB, {
        slug: `rpt-noip-${crypto.randomUUID().slice(0, 8)}`,
        userId,
      });
      await insertClickStat(env.DB, link.id, 1, "2026-03-22");
      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      const createJson = await createRes.json() as { data: { token: string } };
      const token = createJson.data.token;

      // No cf-connecting-ip header → should use "unknown" and be rate limited
      const res = await app.request(`/api/public-report/${token}`, {}, env, mockExecutionCtx());
      expect(res.status).toBe(429);
    });
  });
});
