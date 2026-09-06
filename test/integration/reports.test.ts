import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx, apiRequest, insertClickStat, type JsonBody } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(method: string, path: string, opts: { headers?: Record<string, string>; body?: JsonBody } = {}) {
  return apiRequest(app, method, path, opts);
}

// Independently-derived date helpers for the public report's 30-day timeseries
// window. These deliberately duplicate (rather than import) the route's date
// math so the test can assert real values instead of just "it's an array".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}

/** YYYY-MM-DD (UTC) — matches the `link_stats.date` column format. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "Mon D" (UTC) — matches the public report's timeseries label format. */
function expectedLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Create a team with the given user as a member and return its id. */
async function createTeamWithMember(userId: string): Promise<string> {
  const teamId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO teams (id, name, slug, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
    .bind(teamId, "Report Team", `rpt-team-${teamId.slice(0, 8)}`, now, now)
    .run();
  await env.DB.prepare("INSERT INTO team_members (teamId, userId, role, joinedAt) VALUES (?, ?, ?, ?)")
    .bind(teamId, userId, "member", now)
    .run();
  return teamId;
}

/** Move an existing link under a team. */
async function assignLinkToTeam(linkId: string, teamId: string): Promise<void> {
  await env.DB.prepare("UPDATE links SET teamId = ? WHERE id = ?").bind(teamId, linkId).run();
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
  // GET /api/reports/:linkId — read-only lookup
  // -------------------------------------------------------------------------
  describe("GET /api/reports/:linkId", () => {
    it("returns null and creates nothing when no report exists", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-get-none-${crypto.randomUUID().slice(0,8)}`, userId });

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: null };
      expect(json.data).toBeNull();

      const row = await env.DB.prepare("SELECT count(*) AS n FROM public_reports WHERE linkId = ?")
        .bind(link.id).first() as { n: number };
      expect(row.n).toBe(0);
    });

    it("returns the existing report", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-get-one-${crypto.randomUUID().slice(0,8)}`, userId });
      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      const created = await createRes.json() as { data: { token: string } };

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { token: string; isEnabled: boolean; linkId: string } };
      expect(json.data.token).toBe(created.data.token);
      expect(json.data.isEnabled).toBe(true);
      expect(json.data.linkId).toBe(link.id);
    });

    it("returns 404 for a link the caller cannot access", async () => {
      const otherAuth = await setupAuth(env, { email: `rpt-get-other-${Date.now()}@test.com` });
      const link = await createTestLink(env.DB, {
        slug: `rpt-get-other-${crypto.randomUUID().slice(0,8)}`,
        userId: otherAuth.user.id,
      });

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a non-existent link", async () => {
      const res = await api("GET", "/api/reports/nonexistent-link-id", { headers });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Team-member access
  // -------------------------------------------------------------------------
  describe("team member access", () => {
    it("lets a teammate create and read a report for a team link", async () => {
      const ownerAuth = await setupAuth(env, { email: `rpt-team-owner-${Date.now()}@test.com` });
      const link = await createTestLink(env.DB, {
        slug: `rpt-team-${crypto.randomUUID().slice(0,8)}`,
        userId: ownerAuth.user.id,
      });
      const teamId = await createTeamWithMember(userId);
      await assignLinkToTeam(link.id, teamId);

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
      const ownerAuth = await setupAuth(env, { email: `rpt-team-ex-${Date.now()}@test.com` });
      const link = await createTestLink(env.DB, {
        slug: `rpt-team-ex-${crypto.randomUUID().slice(0,8)}`,
        userId: ownerAuth.user.id,
      });
      const teamId = await createTeamWithMember(userId);
      await assignLinkToTeam(link.id, teamId);

      await env.DB.prepare("DELETE FROM team_members WHERE teamId = ? AND userId = ?")
        .bind(teamId, userId).run();

      const res = await api("GET", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });
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

    it("rejects an internal link with 400 and creates no report row", async () => {
      // The public viewer 404s an internal link, so the token would be dead on arrival.
      const link = await createTestLink(env.DB, {
        slug: `rpt-int-${crypto.randomUUID().slice(0,8)}`,
        userId,
        isInternal: true,
      });

      const res = await api("POST", `/api/reports/${link.id}`, { headers });
      expect(res.status).toBe(400);

      const row = await env.DB.prepare("SELECT id FROM public_reports WHERE linkId = ?").bind(link.id).first();
      expect(row).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/reports/:linkId — set isEnabled
  // -------------------------------------------------------------------------
  describe("PUT /api/reports/:linkId", () => {
    it("rejects re-enabling a report on a link that became internal", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-int-put-${crypto.randomUUID().slice(0,8)}`, userId });
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
      const link = await createTestLink(env.DB, { slug: `rpt-set1-${crypto.randomUUID().slice(0,8)}`, userId });
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
      const link = await createTestLink(env.DB, { slug: `rpt-badbody-${crypto.randomUUID().slice(0,8)}`, userId });
      await api("POST", `/api/reports/${link.id}`, { headers });

      for (const body of [{}, { isEnabled: "true" }, { isEnabled: 1 }, { isEnabled: null }]) {
        const res = await api("PUT", `/api/reports/${link.id}`, { headers, body });
        expect(res.status).toBe(400);
      }
    });

    it("returns 404 if no report exists for the link", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-noreport-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: true } });
      expect(res.status).toBe(404);
    });

    it("returns 401 for unauthenticated request", async () => {
      const link = await createTestLink(env.DB, { slug: `rpt-put-unauth-${crypto.randomUUID().slice(0,8)}`, userId });
      const res = await api("PUT", `/api/reports/${link.id}`, {
        headers: { "Content-Type": "application/json" },
        body: { isEnabled: true },
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
      // Two rows inside the rolling 30-day window, in reverse-chronological
      // insert order (route must sort ascending by date regardless).
      const twoDaysAgo = daysAgo(2);
      const oneDayAgo = daysAgo(1);
      // One row well outside the 30-day window — must count toward the
      // all-time totalClicks but be excluded from the timeseries.
      const outsideWindow = daysAgo(40);

      await insertClickStat(env.DB, link.id, 5, isoDate(oneDayAgo));
      await insertClickStat(env.DB, link.id, 10, isoDate(twoDaysAgo));
      await insertClickStat(env.DB, link.id, 99, isoDate(outsideWindow));

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
      // All-time total includes the out-of-window row.
      expect(json.data.totalClicks).toBe(5 + 10 + 99);
      // Timeseries is limited to the 30-day window and sorted ascending by
      // date, so the out-of-window row is excluded and order is flipped
      // relative to insertion order.
      expect(json.data.timeseries.labels).toEqual([expectedLabel(twoDaysAgo), expectedLabel(oneDayAgo)]);
      expect(json.data.timeseries.clicks).toEqual([10, 5]);
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
      await api("PUT", `/api/reports/${link.id}`, { headers, body: { isEnabled: false } });

      const res = await api("GET", `/api/public-report/${token}`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for an internal link", async () => {
      // Internal links need a session to redirect, so their stats stay private too.
      const link = await createTestLink(env.DB, {
        slug: `rpt-internal-${crypto.randomUUID().slice(0, 8)}`,
        userId,
      });
      await insertClickStat(env.DB, link.id, 3, "2026-03-22");

      const createRes = await api("POST", `/api/reports/${link.id}`, { headers });
      const createJson = await createRes.json() as { data: { token: string } };
      const token = createJson.data.token;

      const okRes = await api("GET", `/api/public-report/${token}`);
      expect(okRes.status).toBe(200);

      await env.DB.prepare("UPDATE links SET isInternal = 1 WHERE id = ?").bind(link.id).run();

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
