import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, apiRequest, insertClickStat } from "../helpers";
import { formatDate } from "../../src/lib/date";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(method: string, path: string, opts: { headers?: Record<string, string> } = {}) {
  return apiRequest(app, method, path, opts);
}

function insertLinkStat(linkId: string, date: string, clicks: number, uniqueClicks = clicks) {
  return insertClickStat(env.DB, linkId, clicks, date, uniqueClicks);
}

// Build an ISO date string N days before today. Used for test rows that need
// to stay inside a runtime-computed cutoff window regardless of wall-clock drift.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Stats API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth(env);
    headers = auth.headers;
    userId = auth.user.id;
  });

  // -------------------------------------------------------------------------
  // Middleware: linkId validation + ownership
  // -------------------------------------------------------------------------
  describe("linkId validation", () => {
    it("returns 400 for an invalid linkId format (not UUID)", async () => {
      const res = await api("GET", "/api/stats/not-a-uuid/timeseries", { headers });
      expect(res.status).toBe(400);
    });

    it("returns 400 for a short alphanumeric ID", async () => {
      const res = await api("GET", "/api/stats/abc123/summary", { headers });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a well-formed UUID that does not exist", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await api("GET", `/api/stats/${fakeId}/timeseries`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a link owned by a different user", async () => {
      const otherAuth = await setupAuth(env, { email: "stats-other@test.com" });
      const link = await createTestLink(env.DB, {
        slug: "stats-other-link",
        userId: otherAuth.user.id,
      });
      const res = await api("GET", `/api/stats/${link.id}/timeseries`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 401 for an unauthenticated request", async () => {
      const link = await createTestLink(env.DB, { slug: "stats-unauth", userId });
      const res = await api("GET", `/api/stats/${link.id}/timeseries`);
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/timeseries — fallback path (AE unavailable in tests)
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/timeseries", () => {
    it("returns fallback timeseries with empty arrays when no stats exist", async () => {
      const link = await createTestLink(env.DB, { slug: "ts-empty", userId });
      const res = await api("GET", `/api/stats/${link.id}/timeseries`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { labels: string[]; clicks: number[] }; fallback?: boolean };
      expect(json.data.labels).toEqual([]);
      expect(json.data.clicks).toEqual([]);
      expect(json.fallback).toBe(true);
    });

    it("returns D1 fallback data when link_stats rows exist", async () => {
      const link = await createTestLink(env.DB, { slug: "ts-with-data", userId });
      await insertLinkStat(link.id, daysAgo(5), 5);
      await insertLinkStat(link.id, daysAgo(4), 12);
      await insertLinkStat(link.id, daysAgo(3), 8);

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=30`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { labels: string[]; clicks: number[] }; fallback?: boolean };
      expect(json.data.labels).toHaveLength(3);
      expect(json.data.clicks).toHaveLength(3);
      expect(json.data.clicks).toContain(5);
      expect(json.data.clicks).toContain(12);
      expect(json.data.clicks).toContain(8);
      expect(json.fallback).toBe(true);
    });

    it("respects the days query parameter and excludes old rows", async () => {
      const link = await createTestLink(env.DB, { slug: "ts-days-filter", userId });
      // Very old row — should be excluded with days=7
      await insertLinkStat(link.id, "2020-01-01", 999);
      // Recent row — should be included
      const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      await insertLinkStat(link.id, recent, 42);

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=7`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { clicks: number[] } };
      expect(json.data.clicks).not.toContain(999);
      expect(json.data.clicks).toContain(42);
    });

    it("accepts period parameter without error (ignored in fallback)", async () => {
      const link = await createTestLink(env.DB, { slug: "ts-period", userId });
      for (const period of ["hour", "day", "week"]) {
        const res = await api("GET", `/api/stats/${link.id}/timeseries?period=${period}`, { headers });
        expect(res.status).toBe(200);
      }
    });

    it("formats labels as readable dates (MMM D)", async () => {
      const link = await createTestLink(env.DB, { slug: "ts-labels", userId });
      const isoDate = daysAgo(10);
      await insertLinkStat(link.id, isoDate, 7);

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=90`, { headers });
      const json = await res.json() as { data: { labels: string[] } };
      expect(json.data.labels).toContain(formatDate(isoDate));
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/geo — fallback path
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/geo", () => {
    it("returns fallback geo with empty arrays", async () => {
      const link = await createTestLink(env.DB, { slug: "geo-empty", userId });
      const res = await api("GET", `/api/stats/${link.id}/geo`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { countries: unknown[]; cities: unknown[] }; fallback?: boolean };
      expect(json.data.countries).toEqual([]);
      expect(json.data.cities).toEqual([]);
      expect(json.fallback).toBe(true);
    });

    it("accepts days query parameter without error", async () => {
      const link = await createTestLink(env.DB, { slug: "geo-days", userId });
      const res = await api("GET", `/api/stats/${link.id}/geo?days=14`, { headers });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/devices — fallback path
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/devices", () => {
    it("returns fallback devices with empty arrays", async () => {
      const link = await createTestLink(env.DB, { slug: "dev-empty", userId });
      const res = await api("GET", `/api/stats/${link.id}/devices`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { browsers: unknown[]; os: unknown[]; devices: unknown[] };
        fallback?: boolean;
      };
      expect(json.data.browsers).toEqual([]);
      expect(json.data.os).toEqual([]);
      expect(json.data.devices).toEqual([]);
      expect(json.fallback).toBe(true);
    });

    it("accepts days query parameter without error", async () => {
      const link = await createTestLink(env.DB, { slug: "dev-days", userId });
      const res = await api("GET", `/api/stats/${link.id}/devices?days=60`, { headers });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/referrers — fallback path
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/referrers", () => {
    it("returns fallback referrers with empty data array", async () => {
      const link = await createTestLink(env.DB, { slug: "ref-empty", userId });
      const res = await api("GET", `/api/stats/${link.id}/referrers`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[]; fallback?: boolean };
      expect(json.data).toEqual([]);
      expect(json.fallback).toBe(true);
    });

    it("accepts days query parameter without error", async () => {
      const link = await createTestLink(env.DB, { slug: "ref-days", userId });
      const res = await api("GET", `/api/stats/${link.id}/referrers?days=7`, { headers });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/summary — fallback path
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/summary", () => {
    it("returns fallback summary with zero clicks when no stats exist", async () => {
      const link = await createTestLink(env.DB, { slug: "sum-zero", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: {
          totalClicks: number;
          uniqueUserAgents: number;
          topCountry: string | null;
          topReferrer: string | null;
          period: { days: number };
        };
        fallback?: boolean;
      };
      expect(json.data.totalClicks).toBe(0);
      expect(json.data.uniqueUserAgents).toBe(0);
      expect(json.data.topCountry).toBeNull();
      expect(json.data.topReferrer).toBeNull();
      expect(json.data.period.days).toBe(30); // default
      expect(json.fallback).toBe(true);
    });

    it("aggregates totalClicks from D1 link_stats rows", async () => {
      const link = await createTestLink(env.DB, { slug: "sum-clicks", userId });
      await insertLinkStat(link.id, daysAgo(5), 10);
      await insertLinkStat(link.id, daysAgo(4), 20);
      await insertLinkStat(link.id, daysAgo(3), 30);

      const res = await api("GET", `/api/stats/${link.id}/summary?days=90`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalClicks: number } };
      expect(json.data.totalClicks).toBe(60);
    });

    it("respects days parameter and excludes old stats rows", async () => {
      const link = await createTestLink(env.DB, { slug: "sum-days-filter", userId });
      // Very old row — should be excluded
      await insertLinkStat(link.id, "2020-06-01", 500);
      // Recent row — should be included
      const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      await insertLinkStat(link.id, recent, 15);

      const res = await api("GET", `/api/stats/${link.id}/summary?days=7`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalClicks: number; period: { days: number } } };
      expect(json.data.totalClicks).toBe(15);
      expect(json.data.period.days).toBe(7);
    });

    it("returns correct period.days when days param is provided", async () => {
      const link = await createTestLink(env.DB, { slug: "sum-period-days", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary?days=14`, { headers });
      const json = await res.json() as { data: { period: { days: number } } };
      expect(json.data.period.days).toBe(14);
    });

    it("caps days at 90", async () => {
      const link = await createTestLink(env.DB, { slug: "sum-days-cap", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary?days=999`, { headers });
      const json = await res.json() as { data: { period: { days: number } } };
      expect(json.data.period.days).toBe(90);
    });

    it("falls back to default 30 days when days param is invalid", async () => {
      const link = await createTestLink(env.DB, { slug: "sum-invalid-days", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary?days=notanumber`, { headers });
      const json = await res.json() as { data: { period: { days: number } } };
      expect(json.data.period.days).toBe(30);
    });
  });
});
