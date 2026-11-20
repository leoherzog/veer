import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { setupAuth, createTestLink, api, insertClickStat, isoDaysAgo, dayLabel } from "../helpers";
import type { AERow } from "../../src/services/analytics";

// vitest.config.ts pins the AE credentials empty, so a request takes the D1
// fallback unless it is sent with this env and a stubbed fetch.
const aeEnv = { ...env, CF_ACCOUNT_ID: "test-account-id", CF_API_TOKEN: "test-api-token" };

const DAY_MS = 86_400_000;

/**
 * Stub the AE SQL API with its documented `{ meta, data, rows }` body and record
 * each query. `rowsFor` picks the rows for one query from its SQL. A fresh
 * Response per call, since a body reads once and an endpoint may query several times.
 */
function stubAE(rowsFor: (sql: string) => AERow[] = () => []) {
  const queries: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const sql = String(init?.body);
    queries.push(sql);
    const data = rowsFor(sql);
    return Response.json({ meta: [], data, rows: data.length });
  });
  return queries;
}

/** Epoch seconds of a YYYY-MM-DD date's UTC midnight, as `toUnixTimestamp(toStartOfDay(...))` returns it. */
const unixDay = (iso: string) => Date.parse(iso) / 1000;

/** The Monday on or before a YYYY-MM-DD date. */
function mondayOf(iso: string): string {
  const t = Date.parse(iso);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** Labels for the daily buckets of a `days` window: the cutoff date through today. */
function dailyLabels(days: number): string[] {
  return Array.from({ length: days + 1 }, (_, i) => dayLabel(isoDaysAgo(days - i)));
}

type Json<T> = { data: T; fallback?: boolean };
type Series = { labels: string[]; clicks: number[] };

describe("Stats API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
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
  // Fallback matrix: every endpoint answers { data, fallback: true } when AE is
  // unconfigured or fails. A link with no clicks shows each endpoint's empty shape.
  // -------------------------------------------------------------------------
  describe("fallback matrix", () => {
    const EMPTY: [string, unknown][] = [
      ["timeseries", { labels: dailyLabels(30), clicks: new Array(31).fill(0) }],
      ["geo", { countries: [], cities: [] }],
      ["devices", { browsers: [], os: [], devices: [] }],
      ["referrers", []],
      ["summary", { totalClicks: 0, uniqueUserAgents: 0, topCountry: null, topReferrer: null, period: { days: 30 } }],
      ["ab", []],
    ];

    it.each(EMPTY)("%s falls back when the AE credentials are unset", async (endpoint, data) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/${endpoint}`, { headers });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data, fallback: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each(EMPTY)("%s falls back when the AE query fails", async (endpoint, data) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/${endpoint}`, { headers, env: aeEnv });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data, fallback: true });
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // D1 fallback data
  // -------------------------------------------------------------------------
  describe("GET /api/stats/:linkId/timeseries (D1 fallback)", () => {
    it("fills every day of the window, with zero for a day without clicks", async () => {
      const link = await createTestLink({ slug: "ts-with-data", userId });
      await insertClickStat(link.id, 5, isoDaysAgo(5));
      await insertClickStat(link.id, 12, isoDaysAgo(4));
      await insertClickStat(link.id, 8, isoDaysAgo(2));

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=7`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as Json<Series>;
      expect(json.fallback).toBe(true);
      expect(json.data.labels).toEqual(dailyLabels(7));
      // Index i is the day 7 - i days ago.
      expect(json.data.clicks).toEqual([0, 0, 5, 12, 0, 8, 0, 0]);
    });

    it("excludes rows older than the window", async () => {
      const link = await createTestLink({ slug: "ts-days-filter", userId });
      await insertClickStat(link.id, 999, "2020-01-01");
      await insertClickStat(link.id, 42, isoDaysAgo(2));

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=7`, { headers });
      const json = await res.json() as Json<Series>;
      expect(json.data.clicks).not.toContain(999);
      expect(json.data.clicks.reduce((s, n) => s + n, 0)).toBe(42);
    });
  });

  describe("GET /api/stats/:linkId/summary (D1 fallback)", () => {
    it("aggregates totalClicks from D1 link_stats rows", async () => {
      const link = await createTestLink({ slug: "sum-clicks", userId });
      await insertClickStat(link.id, 10, isoDaysAgo(5));
      await insertClickStat(link.id, 20, isoDaysAgo(4));
      await insertClickStat(link.id, 30, isoDaysAgo(3));

      const res = await api("GET", `/api/stats/${link.id}/summary?days=90`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as Json<{ totalClicks: number }>;
      expect(json.data.totalClicks).toBe(60);
    });

    it("respects days parameter and excludes old stats rows", async () => {
      const link = await createTestLink({ slug: "sum-days-filter", userId });
      await insertClickStat(link.id, 500, "2020-06-01");
      await insertClickStat(link.id, 15, isoDaysAgo(3));

      const res = await api("GET", `/api/stats/${link.id}/summary?days=7`, { headers });
      const json = await res.json() as Json<{ totalClicks: number; period: { days: number } }>;
      expect(json.data.totalClicks).toBe(15);
      expect(json.data.period.days).toBe(7);
    });

    it("caps days at 90", async () => {
      const link = await createTestLink({ slug: "sum-days-cap", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary?days=999`, { headers });
      const json = await res.json() as Json<{ period: { days: number } }>;
      expect(json.data.period.days).toBe(90);
    });

    it("falls back to default 30 days when days param is invalid", async () => {
      const link = await createTestLink({ slug: "sum-invalid-days", userId });
      const res = await api("GET", `/api/stats/${link.id}/summary?days=notanumber`, { headers });
      const json = await res.json() as Json<{ period: { days: number } }>;
      expect(json.data.period.days).toBe(30);
    });
  });

  // -------------------------------------------------------------------------
  // AE failure modes
  // -------------------------------------------------------------------------
  describe("AE query failure falls back to D1", () => {
    it("timeseries falls back to D1 data when the AE fetch rejects", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
      const link = await createTestLink({ slug: "ts-ae-fail", userId });
      await insertClickStat(link.id, 17, isoDaysAgo(2));

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=30`, { headers, env: aeEnv });
      const json = await res.json() as Json<Series>;
      expect(json.fallback).toBe(true);
      expect(json.data.clicks).toContain(17);
      expect(fetchSpy.mock.calls[0][0]).toContain("/analytics_engine/sql");
    });

    it("logs the AE response text and the route on a non-2xx answer", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad query", { status: 422 }));
      const link = await createTestLink({ slug: "sum-ae-422", userId });
      await insertClickStat(link.id, 11, isoDaysAgo(2));
      await insertClickStat(link.id, 22, isoDaysAgo(1));

      const res = await api("GET", `/api/stats/${link.id}/summary?days=30`, { headers, env: aeEnv });
      const json = await res.json() as Json<{ totalClicks: number }>;
      expect(json).toMatchObject({ data: { totalClicks: 33 }, fallback: true });
      const entry = JSON.parse(String(log.mock.calls[0][0])) as { error: string; route: string };
      expect(entry.error).toBe("AE API returned 422: bad query");
      expect(entry.route).toBe("/api/stats/:linkId/summary");
    });

    it("falls back when a 200 body has no data array", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: true }));
      const link = await createTestLink({ slug: "ref-ae-nodata", userId });

      const res = await api("GET", `/api/stats/${link.id}/referrers`, { headers, env: aeEnv });
      expect(await res.json()).toEqual({ data: [], fallback: true });
    });
  });

  // -------------------------------------------------------------------------
  // AE success: one test per reader, asserting the AE column it reads.
  // -------------------------------------------------------------------------
  describe("AE query success", () => {
    it("timeseries sums sampled clicks per UTC day and zero-fills the window", async () => {
      const queries = stubAE(() => [
        { t: unixDay(isoDaysAgo(2)), clicks: "4" },
        { t: unixDay(isoDaysAgo(0)), clicks: 1 },
      ]);
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/timeseries?days=7`, { headers, env: aeEnv });
      const json = await res.json() as Json<Series>;
      expect(json.fallback).toBeUndefined();
      expect(json.data).toEqual({ labels: dailyLabels(7), clicks: [0, 0, 0, 0, 0, 4, 0, 1] });
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain("toUnixTimestamp(toStartOfDay(timestamp)) as t, SUM(_sample_interval) as clicks");
      expect(queries[0]).toContain(`FROM ${env.AE_DATASET} WHERE index1 = '${link.id}' AND timestamp > now() - interval '7' day`);
    });

    it("timeseries buckets by hour over at most 48 hours", async () => {
      const thisHour = Math.floor(Date.now() / 3_600_000) * 3600;
      const queries = stubAE(() => [{ t: thisHour, clicks: "2" }]);
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/timeseries?period=hour&days=1`, { headers, env: aeEnv });
      const json = await res.json() as Json<Series>;
      expect(json.data.clicks).toHaveLength(25);
      expect(json.data.clicks.at(-1)).toBe(2);
      expect(json.data.clicks.slice(0, -1).every((n) => n === 0)).toBe(true);
      expect(queries[0]).toContain("toStartOfHour(timestamp)");
      expect(queries[0]).toContain("interval '24' hour");
    });

    it("timeseries sums UTC days into Monday-start weeks", async () => {
      const today = isoDaysAgo(0);
      const monday = mondayOf(today);
      stubAE(() => [
        { t: unixDay(monday), clicks: 2 },
        { t: unixDay(today), clicks: 3 },
      ]);
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/timeseries?period=week&days=30`, { headers, env: aeEnv });
      const json = await res.json() as Json<Series>;
      const weeks = (Date.parse(monday) - Date.parse(mondayOf(isoDaysAgo(30)))) / (7 * DAY_MS) + 1;
      expect(json.data.labels).toHaveLength(weeks);
      expect(json.data.labels.at(-1)).toBe(`Week of ${dayLabel(monday)}`);
      expect(json.data.labels[0]).toBe(`Week of ${dayLabel(mondayOf(isoDaysAgo(30)))}`);
      expect(json.data.clicks.at(-1)).toBe(5);
    });

    it("geo reads countries from blob2, labels cities with their country from blob5 + blob2, and merges cityless rows", async () => {
      const queries = stubAE((sql) => sql.includes("blob5")
        ? [
          { city: "Austin", country: "US", clicks: "3" },
          { city: "", country: "US", clicks: "2" },
          { city: "", country: "GB", clicks: 1 },
          { city: "", country: "", clicks: 1 },
        ]
        : [{ country: "US", clicks: "5" }, { country: "", clicks: 2 }]);
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/geo`, { headers, env: aeEnv });
      expect(await res.json()).toEqual({
        data: {
          countries: [{ name: "US", clicks: 5 }, { name: "Unknown", clicks: 2 }],
          cities: [{ name: "Unknown", clicks: 4 }, { name: "Austin, US", clicks: 3 }],
        },
      });
      const citySql = queries.find((q) => q.includes("blob5"))!;
      expect(citySql).toContain("SELECT blob5 as city, blob2 as country, SUM(_sample_interval) as clicks");
      expect(citySql).toContain("GROUP BY city, country ORDER BY clicks DESC LIMIT 200");
      expect(queries.find((q) => !q.includes("blob5"))).toContain("SELECT blob2 as country, SUM(_sample_interval) as clicks");
    });

    it("devices parses the user agents in blob3", async () => {
      const queries = stubAE(() => [
        { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", clicks: "3" },
        { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", clicks: 2 },
      ]);
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/devices`, { headers, env: aeEnv });
      expect(await res.json()).toEqual({
        data: {
          browsers: [{ name: "Chrome", clicks: 3 }, { name: "Safari", clicks: 2 }],
          os: [{ name: "Windows", clicks: 3 }, { name: "iOS", clicks: 2 }],
          devices: [{ name: "desktop", clicks: 3 }, { name: "mobile", clicks: 2 }],
        },
      });
      expect(queries[0]).toContain("SELECT blob3 as userAgent, SUM(_sample_interval) as clicks");
    });

    it("referrers groups the referers in blob4 by hostname", async () => {
      const queries = stubAE(() => [
        { referrer: "https://news.example.com/a", clicks: "3" },
        { referrer: "https://news.example.com/b", clicks: "2" },
        { referrer: "https://other.example.org/", clicks: "4" },
      ]);
      const link = await createTestLink({ slug: "ref-ae-ok", userId });

      const res = await api("GET", `/api/stats/${link.id}/referrers?days=7`, { headers, env: aeEnv });
      expect(await res.json()).toEqual({
        data: [
          { source: "news.example.com", clicks: 5 },
          { source: "other.example.org", clicks: 4 },
        ],
      });
      expect(queries[0]).toContain("SELECT blob4 as referrer, SUM(_sample_interval) as clicks");
      expect(queries[0]).toContain(`FROM ${env.AE_DATASET} WHERE index1 = '${link.id}'`);
      expect(queries[0]).toContain("AND blob4 != ''");
    });

    it("summary counts distinct blob3 values and takes its top referrer from the hostname aggregation", async () => {
      const queries = stubAE((sql) => {
        if (sql.includes("count(DISTINCT blob3)")) return [{ totalClicks: "9", uniqueUserAgents: "4" }];
        if (sql.includes("blob2 as country")) return [{ country: "DE", clicks: 5 }];
        // b.example is the top raw referrer, but a.example has more clicks once grouped by host.
        return [
          { referrer: "https://b.example/", clicks: 3 },
          { referrer: "https://a.example/x", clicks: 2 },
          { referrer: "https://a.example/y", clicks: 2 },
        ];
      });
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/summary?days=7`, { headers, env: aeEnv });
      expect(await res.json()).toEqual({
        data: { totalClicks: 9, uniqueUserAgents: 4, topCountry: "DE", topReferrer: "a.example", period: { days: 7 } },
      });
      expect(queries.find((q) => q.includes("count(DISTINCT blob3)"))).toContain("SUM(_sample_interval) as totalClicks");
      expect(queries.find((q) => q.includes("blob2 as country"))).toContain("LIMIT 1");
      expect(queries.find((q) => q.includes("blob4 as referrer"))).toContain("LIMIT 200");
    });

    it("ab groups clicks by the destination in blob6", async () => {
      const queries = stubAE(() => [
        { destinationUrl: "https://a.example.com/", clicks: "6" },
        { destinationUrl: "", clicks: 1 },
      ]);
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/stats/${link.id}/ab`, { headers, env: aeEnv });
      expect(await res.json()).toEqual({
        data: [
          { url: "https://a.example.com/", clicks: 6 },
          { url: "(unknown)", clicks: 1 },
        ],
      });
      expect(queries[0]).toContain("SELECT blob6 as destinationUrl, SUM(_sample_interval) as clicks");
      expect(queries[0]).toContain("GROUP BY destinationUrl ORDER BY clicks DESC LIMIT 20");
    });
  });
});
