import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import {
  setupAuth, newUser, createTestLink, createTeamLink, removeTestTeamMember, api, insertClickStat, isoDaysAgo, dayLabel, fakeLimiter,
} from "../helpers";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reports API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
    headers = auth.headers;
    userId = auth.user.id;
  });

  /** Create the link's public report and return its token. */
  async function createReport(linkId: string): Promise<string> {
    const res = await api("POST", `/api/reports/${linkId}`, { headers });
    expect(res.status).toBe(201);
    return (await res.json() as { data: { token: string } }).data.token;
  }

  // -------------------------------------------------------------------------
  // GET /api/reports/:linkId — read-only lookup
  // -------------------------------------------------------------------------
  describe("GET /api/reports/:linkId", () => {
    it("returns null and creates nothing when no report exists", async () => {
      const link = await createTestLink({ userId });

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: null };
      expect(json.data).toBeNull();

      const row = await env.DB.prepare("SELECT count(*) AS n FROM public_reports WHERE linkId = ?")
        .bind(link.id).first() as { n: number };
      expect(row.n).toBe(0);
    });

    it("returns the existing report", async () => {
      const link = await createTestLink({ userId });
      const token = await createReport(link.id);

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { token: string; isEnabled: boolean; linkId: string } };
      expect(json.data.token).toBe(token);
      expect(json.data.isEnabled).toBe(true);
      expect(json.data.linkId).toBe(link.id);
    });

    it("returns 404 for a link the caller cannot access", async () => {
      const other = await newUser("rpt-get-other");
      const link = await createTestLink({ userId: other.user.id });

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a non-existent link", async () => {
      const res = await api("GET", "/api/reports/nonexistent-link-id", { headers });
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe("Link not found");
    });
  });

  // -------------------------------------------------------------------------
  // Team-member access
  // -------------------------------------------------------------------------
  describe("team member access", () => {
    it("lets a teammate create and read a report for a team link", async () => {
      const { link } = await createTeamLink(userId);

      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(createRes.status).toBe(201);

      const getRes = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(getRes.status).toBe(200);
      const json = await getRes.json() as { data: { token: string } };
      expect(json.data.token).toMatch(/^rpt_/);

      const putRes = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });
      expect(putRes.status).toBe(200);
    });

    it("returns 404 once the caller is no longer a team member", async () => {
      const { team, link } = await createTeamLink(userId);
      await removeTestTeamMember(team.id, userId);

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/reports/:linkId — create report
  // -------------------------------------------------------------------------
  describe("POST /api/reports/:linkId", () => {
    it("creates a report for the user's own link", async () => {
      const link = await createTestLink({ userId });
      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { token: string; isEnabled: boolean; createdAt: unknown; linkId: string } };
      expect(json.data.token).toMatch(/^rpt_/);
      expect(json.data.isEnabled).toBe(true);
      expect(json.data.createdAt).toBeTruthy();
      expect(json.data.linkId).toBe(link.id);
    });

    it("returns existing report (idempotent) when called again", async () => {
      const link = await createTestLink({ userId });

      const res1 = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res1.status).toBe(201);
      const json1 = await res1.json() as { data: { token: string } };

      const res2 = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res2.status).toBe(200);
      const json2 = await res2.json() as { data: { token: string } };

      expect(json2.data.token).toBe(json1.data.token);
    });

    it("concurrent creates yield one report, created once", async () => {
      const link = await createTestLink({ userId });

      const responses = await Promise.all([1, 2, 3].map(() => api("POST", `/api/reports/${link.id}`, { headers })));
      expect(responses.map(r => r.status).sort()).toEqual([200, 200, 201]);

      const tokens = await Promise.all(responses.map(async r => (await r.json() as { data: { token: string } }).data.token));
      expect(new Set(tokens).size).toBe(1);
    });

    it("returns 404 for a non-existent link", async () => {
      const res = await api("POST", "/api/reports/nonexistent-link-id", { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a link owned by another user", async () => {
      const other = await newUser("rpt-other");
      const link = await createTestLink({ userId: other.user.id });

      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("rejects an internal link with 400 and creates no report row", async () => {
      // The public viewer 404s an internal link, so the token would be dead on arrival.
      const link = await createTestLink({ userId, isInternal: true });

      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Internal links cannot have a public report" });

      const row = await env.DB.prepare("SELECT linkId FROM public_reports WHERE linkId = ?").bind(link.id).first();
      expect(row).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/reports/:linkId — set isEnabled
  // -------------------------------------------------------------------------
  describe("PUT /api/reports/:linkId", () => {
    it("rejects re-enabling a report on a link that became internal", async () => {
      const link = await createTestLink({ userId });
      await api("POST", `/api/reports/${link.id}`, { headers });
      await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });
      await env.DB.prepare("UPDATE links SET isInternal = 1 WHERE id = ?").bind(link.id).run();

      const res = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: true } });
      expect(res.status).toBe(400);

      // Disabling stays available so the owner can still turn a stale report off.
      const off = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });
      expect(off.status).toBe(200);
    });

    it("sets isEnabled to the value in the body", async () => {
      const link = await createTestLink({ userId });
      await api("POST", `/api/reports/${link.id}`, { headers });

      const off = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });
      expect(off.status).toBe(200);
      expect((await off.json() as { data: { isEnabled: boolean } }).data.isEnabled).toBe(false);

      // Idempotent: sending the same value again keeps it false rather than toggling.
      const stillOff = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });
      expect((await stillOff.json() as { data: { isEnabled: boolean } }).data.isEnabled).toBe(false);

      const on = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: true } });
      expect((await on.json() as { data: { isEnabled: boolean } }).data.isEnabled).toBe(true);

      const persisted = await api("GET", `/api/reports/${link.id}`, { headers });
      expect((await persisted.json() as { data: { isEnabled: boolean } }).data.isEnabled).toBe(true);
    });

    it.each([{}, { isEnabled: "true" }, { isEnabled: 1 }, { isEnabled: null }])(
      "returns 400 when isEnabled is not a boolean: %j",
      async (body) => {
        // The body is checked before the report lookup, so no report is needed.
        const link = await createTestLink({ userId });
        const res = await api("PUT", `/api/reports/${link.id}`, { headers, body });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "isEnabled must be a boolean" });
      },
    );

    it("returns 404 if no report exists for the link", async () => {
      const link = await createTestLink({ userId });
      const res = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: true } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Report not found" });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/public-report/:token — public report viewer
  // -------------------------------------------------------------------------
  describe("GET /api/public-report/:token", () => {
    it("returns stats for a valid enabled token", async () => {
      const link = await createTestLink({ userId, title: "Public Test Link" });
      // Two rows inside the rolling 30-day window, in reverse-chronological
      // insert order (route must sort ascending by date regardless).
      const twoDaysAgo = isoDaysAgo(2);
      const oneDayAgo = isoDaysAgo(1);
      await insertClickStat(link.id, 5, oneDayAgo);
      await insertClickStat(link.id, 10, twoDaysAgo);
      // One row well outside the 30-day window — must count toward the
      // all-time totalClicks but be excluded from the timeseries.
      await insertClickStat(link.id, 99, isoDaysAgo(40));

      const token = await createReport(link.id);

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
      // All-time total includes the out-of-window row.
      expect(json.data.totalClicks).toBe(5 + 10 + 99);
      // The timeseries has one bucket per day from 30 days ago through today,
      // ascending and zero-filled, so the out-of-window row is excluded.
      const { labels, clicks } = json.data.timeseries;
      expect(labels).toHaveLength(31);
      expect(labels[0]).toBe(dayLabel(isoDaysAgo(30)));
      expect(labels.slice(-3)).toEqual([dayLabel(twoDaysAgo), dayLabel(oneDayAgo), dayLabel(isoDaysAgo(0))]);
      expect(clicks.slice(-3)).toEqual([10, 5, 0]);
      expect(clicks.reduce((s, n) => s + n, 0)).toBe(15);
    });

    it("returns 404 for an invalid token", async () => {
      const res = await api("GET", "/api/public-report/rpt_invalidtoken00000000000000000");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    });

    it("returns 404 when report is disabled", async () => {
      const link = await createTestLink({ userId });
      const token = await createReport(link.id);

      await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });

      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for an internal link", async () => {
      // Internal links need a session to redirect, so their stats stay private too.
      const link = await createTestLink({ userId });
      const token = await createReport(link.id);

      const okRes = await api("GET", `/api/public-report/${token}`);
      expect(okRes.status).toBe(200);

      await env.DB.prepare("UPDATE links SET isInternal = 1 WHERE id = ?").bind(link.id).run();

      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(404);
    });

    describe("rate limit", () => {
      it("answers 429 when the limiter refuses the client IP", async () => {
        const link = await createTestLink({ userId });
        const token = await createReport(link.id);
        const limiter = fakeLimiter(false);

        const res = await api("GET", `/api/public-report/${token}`, {
          headers: { "cf-connecting-ip": "203.0.113.30" },
          env: { ...env, PUBLIC_REPORT_RATE_LIMITER: limiter },
        });

        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "Rate limit exceeded", retryAfter: 60 });
        expect(res.headers.get("Retry-After")).toBe("60");
        expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: "203.0.113.30" });
      });

      it("serves the report when the limiter allows the client IP", async () => {
        const link = await createTestLink({ userId });
        const token = await createReport(link.id);
        const limiter = fakeLimiter(true);

        const res = await api("GET", `/api/public-report/${token}`, {
          headers: { "cf-connecting-ip": "203.0.113.31" },
          env: { ...env, PUBLIC_REPORT_RATE_LIMITER: limiter },
        });

        expect(res.status).toBe(200);
        expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: "203.0.113.31" });
      });

      it("keys on 'unknown' when cf-connecting-ip is absent", async () => {
        const limiter = fakeLimiter(false);

        const res = await api("GET", "/api/public-report/rpt_whatever", {
          env: { ...env, PUBLIC_REPORT_RATE_LIMITER: limiter },
        });

        expect(res.status).toBe(429);
        expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: "unknown" });
      });
    });
  });
});
