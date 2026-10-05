import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { setupAuth, createTestLink, createTestTeam, api, insertClickStat, isoDaysAgo, dayLabel } from "../helpers";

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
      const link = await createTestLink({ slug: `rpt-get-none-${crypto.randomUUID().slice(0,8)}`, userId });

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: null };
      expect(json.data).toBeNull();

      const row = await env.DB.prepare("SELECT count(*) AS n FROM public_reports WHERE linkId = ?")
        .bind(link.id).first() as { n: number };
      expect(row.n).toBe(0);
    });

    it("returns the existing report", async () => {
      const link = await createTestLink({ slug: `rpt-get-one-${crypto.randomUUID().slice(0,8)}`, userId });
      const token = await createReport(link.id);

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { token: string; isEnabled: boolean; linkId: string } };
      expect(json.data.token).toBe(token);
      expect(json.data.isEnabled).toBe(true);
      expect(json.data.linkId).toBe(link.id);
    });

    it("returns 404 for a link the caller cannot access", async () => {
      const otherAuth = await setupAuth({ email: `rpt-get-other-${Date.now()}@test.com` });
      const link = await createTestLink({
        slug: `rpt-get-other-${crypto.randomUUID().slice(0,8)}`,
        userId: otherAuth.user.id,
      });

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
      const ownerAuth = await setupAuth({ email: `rpt-team-owner-${Date.now()}@test.com` });
      const team = await createTestTeam(userId, "member");
      const link = await createTestLink({
        slug: `rpt-team-${crypto.randomUUID().slice(0,8)}`,
        userId: ownerAuth.user.id,
        teamId: team.id,
      });

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
      const ownerAuth = await setupAuth({ email: `rpt-team-ex-${Date.now()}@test.com` });
      const team = await createTestTeam(userId, "member");
      const link = await createTestLink({
        slug: `rpt-team-ex-${crypto.randomUUID().slice(0,8)}`,
        userId: ownerAuth.user.id,
        teamId: team.id,
      });

      await env.DB.prepare("DELETE FROM team_members WHERE teamId = ? AND userId = ?")
        .bind(team.id, userId).run();

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/reports/:linkId — create report
  // -------------------------------------------------------------------------
  describe("POST /api/reports/:linkId", () => {
    it("creates a report for the user's own link", async () => {
      const link = await createTestLink({ slug: `rpt-create-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { token: string; isEnabled: boolean; createdAt: unknown; linkId: string } };
      expect(json.data.token).toMatch(/^rpt_/);
      expect(json.data.isEnabled).toBe(true);
      expect(json.data.createdAt).toBeTruthy();
      expect(json.data.linkId).toBe(link.id);
    });

    it("returns existing report (idempotent) when called again", async () => {
      const link = await createTestLink({ slug: `rpt-idem-${crypto.randomUUID().slice(0,8)}`, userId });

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
      const otherAuth = await setupAuth({ email: `rpt-other-${Date.now()}@test.com` });
      const link = await createTestLink({
        slug: `rpt-other-${crypto.randomUUID().slice(0,8)}`,
        userId: otherAuth.user.id,
      });

      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("rejects an internal link with 400 and creates no report row", async () => {
      // The public viewer 404s an internal link, so the token would be dead on arrival.
      const link = await createTestLink({
        slug: `rpt-int-${crypto.randomUUID().slice(0,8)}`,
        userId,
        isInternal: true,
      });

      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(400);

      const row = await env.DB.prepare("SELECT linkId FROM public_reports WHERE linkId = ?").bind(link.id).first();
      expect(row).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/reports/:linkId — set isEnabled
  // -------------------------------------------------------------------------
  describe("PUT /api/reports/:linkId", () => {
    it("rejects re-enabling a report on a link that became internal", async () => {
      const link = await createTestLink({ slug: `rpt-int-put-${crypto.randomUUID().slice(0,8)}`, userId });
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
      const link = await createTestLink({ slug: `rpt-set1-${crypto.randomUUID().slice(0,8)}`, userId });
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

    it("returns 400 when isEnabled is not a boolean", async () => {
      const link = await createTestLink({ slug: `rpt-badbody-${crypto.randomUUID().slice(0,8)}`, userId });
      await api("POST", `/api/reports/${link.id}`, { headers });

      for (const body of [{}, { isEnabled: "true" }, { isEnabled: 1 }, { isEnabled: null }]) {
        const res = await api("PUT", `/api/reports/${link.id}`, { headers, body });
        expect(res.status).toBe(400);
      }
    });

    it("returns 404 if no report exists for the link", async () => {
      const link = await createTestLink({ slug: `rpt-noreport-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: true } });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/public-report/:token — public report viewer
  // -------------------------------------------------------------------------
  describe("GET /api/public-report/:token", () => {
    it("returns stats for a valid enabled token", async () => {
      const link = await createTestLink({
        slug: `rpt-pub-${crypto.randomUUID().slice(0,8)}`,
        userId,
        title: "Public Test Link",
      });
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
      // Timeseries is limited to the 30-day window and sorted ascending by
      // date, so the out-of-window row is excluded and order is flipped
      // relative to insertion order.
      expect(json.data.timeseries.labels).toEqual([dayLabel(twoDaysAgo), dayLabel(oneDayAgo)]);
      expect(json.data.timeseries.clicks).toEqual([10, 5]);
    });

    it("returns 404 for an invalid token", async () => {
      const res = await api("GET", "/api/public-report/rpt_invalidtoken00000000000000000");
      expect(res.status).toBe(404);
    });

    it("returns 404 when link is deactivated", async () => {
      const link = await createTestLink({
        slug: `rpt-deact-${crypto.randomUUID().slice(0, 8)}`,
        userId,
        title: "Deactivated Link",
      });

      const token = await createReport(link.id);

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
      const link = await createTestLink({
        slug: `rpt-disabled-${crypto.randomUUID().slice(0,8)}`,
        userId,
      });

      const token = await createReport(link.id);

      // Disable the report
      await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });

      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for an internal link", async () => {
      // Internal links need a session to redirect, so their stats stay private too.
      const link = await createTestLink({
        slug: `rpt-internal-${crypto.randomUUID().slice(0, 8)}`,
        userId,
      });

      const token = await createReport(link.id);

      const okRes = await api("GET", `/api/public-report/${token}`);
      expect(okRes.status).toBe(200);

      await env.DB.prepare("UPDATE links SET isInternal = 1 WHERE id = ?").bind(link.id).run();

      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(404);
    });

    it("rate limits by IP after 30 requests", async () => {
      const link = await createTestLink({
        slug: `rpt-rl-${crypto.randomUUID().slice(0, 8)}`,
        userId,
      });
      const token = await createReport(link.id);

      // Pre-seed the KV counter to 29 so we only need 1 more to hit the limit
      const testIp = `10.0.0.${Date.now() % 256}`;
      const windowEpoch = Math.floor(Date.now() / 1000 / 60);
      const rlKey = `rl:pub:${testIp}:${windowEpoch}`;
      await env.KV.put(rlKey, "29", { expirationTtl: 120 });

      // Request 30 should succeed. Its counter write runs in waitUntil, so await it before request 31.
      const ctx = createExecutionContext();
      const res30 = await api("GET", `/api/public-report/${token}`, { headers: { "cf-connecting-ip": testIp }, ctx });
      expect(res30.status).toBe(200);
      await waitOnExecutionContext(ctx);

      // Request 31 should be rate limited
      const res31 = await api("GET", `/api/public-report/${token}`, { headers: { "cf-connecting-ip": testIp } });
      expect(res31.status).toBe(429);
    });

    it("uses 'unknown' as IP key when cf-connecting-ip is absent", async () => {
      const windowEpoch = Math.floor(Date.now() / 1000 / 60);
      const rlKey = `rl:pub:unknown:${windowEpoch}`;
      await env.KV.put(rlKey, "30", { expirationTtl: 120 });

      const link = await createTestLink({
        slug: `rpt-noip-${crypto.randomUUID().slice(0, 8)}`,
        userId,
      });
      const token = await createReport(link.id);

      // No cf-connecting-ip header → should use "unknown" and be rate limited
      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(429);
    });
  });
});
