import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupAuth, createTestLink, api, insertClickStat, isoDaysAgo, dayLabel } from "../helpers";

// vitest.config.ts pins the AE credentials empty, so a request takes the D1
// fallback unless it is sent with this env and a stubbed fetch.
const aeEnv = { ...env, CF_ACCOUNT_ID: "test-account-id", CF_API_TOKEN: "test-api-token" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Stats API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
    headers = auth.headers;
    userId = auth.user.id;
  });

  afterEach(() => {
    // Undo any globalThis.fetch spy installed by the error-path tests.
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Middleware: linkId validation + ownership
  // -------------------------------------------------------------------------
  describe("linkId validation", () => {
    it("returns 400 for an invalid linkId format (not UUID)", async () => {
      const res = await api("GET", "/api/stats/not-a-uuid/timeseries", { headers });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a well-formed UUID that does not exist", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await api("GET", `/api/stats/${fakeId}/timeseries`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a link owned by a different user", async () => {
      const otherAuth = await setupAuth({ email: "stats-other@test.com" });
      const link = await createTestLink({
        slug: "stats-other-link",
        userId: otherAuth.user.id,
      });
      const res = await api("GET", `/api/stats/${link.id}/timeseries`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/timeseries — fallback path (no AE credentials)
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/timeseries", () => {
    it("returns fallback timeseries with empty arrays when no stats exist", async () => {
      const link = await createTestLink({ slug: "ts-empty", userId });
      const res = await api("GET", `/api/stats/${link.id}/timeseries`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { labels: string[]; clicks: number[] }; fallback?: boolean };
      expect(json.data.labels).toEqual([]);
      expect(json.data.clicks).toEqual([]);
      expect(json.fallback).toBe(true);
    });

    it("returns D1 fallback data when link_stats rows exist", async () => {
      const link = await createTestLink({ slug: "ts-with-data", userId });
      await insertClickStat(link.id, 5, isoDaysAgo(5));
      await insertClickStat(link.id, 12, isoDaysAgo(4));
      await insertClickStat(link.id, 8, isoDaysAgo(3));

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
      const link = await createTestLink({ slug: "ts-days-filter", userId });
      // Very old row — should be excluded with days=7
      await insertClickStat(link.id, 999, "2020-01-01");
      // Recent row — should be included
      await insertClickStat(link.id, 42, isoDaysAgo(2));

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=7`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { clicks: number[] } };
      expect(json.data.clicks).not.toContain(999);
      expect(json.data.clicks).toContain(42);
    });

    it("formats labels as readable dates (MMM D)", async () => {
      const link = await createTestLink({ slug: "ts-labels", userId });
      // Dates relative to today can never fall out of the rolling window.
      const dateA = isoDaysAgo(2);
      const dateB = isoDaysAgo(1);
      await insertClickStat(link.id, 7, dateA);
      await insertClickStat(link.id, 3, dateB);

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=90`, { headers });
      const json = await res.json() as { data: { labels: string[] } };
      expect(json.data.labels).toContain(dayLabel(dateA));
      expect(json.data.labels).toContain(dayLabel(dateB));
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/geo — fallback path (no AE credentials)
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/geo", () => {
    it("returns fallback geo with empty arrays", async () => {
      const link = await createTestLink({ slug: "geo-empty", userId });
      const res = await api("GET", `/api/stats/${link.id}/geo`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { countries: unknown[]; cities: unknown[] }; fallback?: boolean };
      expect(json.data.countries).toEqual([]);
      expect(json.data.cities).toEqual([]);
      expect(json.fallback).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/devices — fallback path (no AE credentials)
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/devices", () => {
    it("returns fallback devices with empty arrays", async () => {
      const link = await createTestLink({ slug: "dev-empty", userId });
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
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/referrers — fallback path (no AE credentials)
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/referrers", () => {
    it("returns fallback referrers with empty data array", async () => {
      const link = await createTestLink({ slug: "ref-empty", userId });
      const res = await api("GET", `/api/stats/${link.id}/referrers`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[]; fallback?: boolean };
      expect(json.data).toEqual([]);
      expect(json.fallback).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/stats/:linkId/summary — fallback path (no AE credentials)
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/summary", () => {
    it("returns fallback summary with zero clicks when no stats exist", async () => {
      const link = await createTestLink({ slug: "sum-zero", userId });
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
      const link = await createTestLink({ slug: "sum-clicks", userId });
      await insertClickStat(link.id, 10, isoDaysAgo(5));
      await insertClickStat(link.id, 20, isoDaysAgo(4));
      await insertClickStat(link.id, 30, isoDaysAgo(3));

      const res = await api("GET", `/api/stats/${link.id}/summary?days=90`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalClicks: number } };
      expect(json.data.totalClicks).toBe(60);
    });

    it("respects days parameter and excludes old stats rows", async () => {
      const link = await createTestLink({ slug: "sum-days-filter", userId });
      // Very old row — should be excluded
      await insertClickStat(link.id, 500, "2020-06-01");
      // Recent row — should be included
      await insertClickStat(link.id, 15, isoDaysAgo(3));

      const res = await api("GET", `/api/stats/${link.id}/summary?days=7`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalClicks: number; period: { days: number } } };
      expect(json.data.totalClicks).toBe(15);
      expect(json.data.period.days).toBe(7);
    });

    it("caps days at 90", async () => {
      const link = await createTestLink({ slug: "sum-days-cap", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary?days=999`, { headers });
      const json = await res.json() as { data: { period: { days: number } } };
      expect(json.data.period.days).toBe(90);
    });

    it("falls back to default 30 days when days param is invalid", async () => {
      const link = await createTestLink({ slug: "sum-invalid-days", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary?days=notanumber`, { headers });
      const json = await res.json() as { data: { period: { days: number } } };
      expect(json.data.period.days).toBe(30);
    });
  });

  // -------------------------------------------------------------------------
  // Error path: AE credentials are set, but the AE SQL query fails → D1 fallback.
  // A stubbed fetch makes the failure deterministic and keeps the test offline.
  // -------------------------------------------------------------------------
  describe("AE query failure falls back to D1", () => {
    it("timeseries falls back to D1 data when the AE fetch rejects", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

      const link = await createTestLink({ slug: "ts-ae-fail", userId });
      await insertClickStat(link.id, 17, isoDaysAgo(2));

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=30`, { headers, env: aeEnv });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { clicks: number[] }; fallback?: boolean };
      expect(json.fallback).toBe(true);
      expect(json.data.clicks).toContain(17);
      // Prove the AE fetch was actually attempted.
      expect(fetchSpy).toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0][0]).toContain("/analytics_engine/sql");
    });

    it("summary falls back to D1 totals when the AE fetch returns 500", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("boom", { status: 500, statusText: "Internal Server Error" })
      );

      const link = await createTestLink({ slug: "sum-ae-fail", userId });
      await insertClickStat(link.id, 11, isoDaysAgo(2));
      await insertClickStat(link.id, 22, isoDaysAgo(1));

      const res = await api("GET", `/api/stats/${link.id}/summary?days=30`, { headers, env: aeEnv });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalClicks: number }; fallback?: boolean };
      expect(json.fallback).toBe(true);
      expect(json.data.totalClicks).toBe(33);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("geo falls back to empty arrays when the AE fetch rejects", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

      const link = await createTestLink({ slug: "geo-ae-fail", userId });
      const res = await api("GET", `/api/stats/${link.id}/geo?days=30`, { headers, env: aeEnv });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { countries: unknown[]; cities: unknown[] }; fallback?: boolean };
      expect(json.fallback).toBe(true);
      expect(json.data.countries).toEqual([]);
      expect(json.data.cities).toEqual([]);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("AE query success", () => {
    it("queries the configured dataset and groups referrers by hostname", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
        success: true,
        data: [
          { referrer: "https://news.example.com/a", clicks: "3" },
          { referrer: "https://news.example.com/b", clicks: "2" },
          { referrer: "https://other.example.org/", clicks: "4" },
        ],
      }));

      const link = await createTestLink({ slug: "ref-ae-ok", userId });
      const res = await api("GET", `/api/stats/${link.id}/referrers?days=7`, { headers, env: aeEnv });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { source: string; clicks: number }[]; fallback?: boolean };
      expect(json.fallback).toBeUndefined();
      expect(json.data).toEqual([
        { source: "news.example.com", clicks: 5 },
        { source: "other.example.org", clicks: 4 },
      ]);
      const query = String(fetchSpy.mock.calls[0][1]?.body);
      expect(query).toContain(`FROM ${env.AE_DATASET} WHERE index1 = '${link.id}'`);
    });
  });
});
