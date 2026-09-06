import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, createTestDomain, mockExecutionCtx, apiRequest, insertClickStat, type JsonBody } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(method: string, path: string, opts: { headers?: Record<string, string>; body?: JsonBody } = {}) {
  return apiRequest(app, method, path, opts);
}

/** Insert a campaign directly into D1. */
async function createTestCampaign(
  userId: string,
  overrides: Partial<{ id: string; name: string; description: string | null }> = {}
) {
  const id = overrides.id ?? crypto.randomUUID();
  const name = overrides.name ?? `Campaign ${id.slice(0, 8)}`;
  const description = overrides.description ?? null;
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO campaigns (id, userId, name, description, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, userId, name, description, now, now)
    .run();

  return { id, userId, name, description, createdAt: now, updatedAt: now };
}

/** Associate a link with a campaign directly in D1. */
async function linkToCampaign(linkId: string, campaignId: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO link_campaigns (linkId, campaignId) VALUES (?, ?)`
  )
    .bind(linkId, campaignId)
    .run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Campaigns API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth(env);
    headers = auth.headers;
    userId = auth.user.id;
  });

  // -------------------------------------------------------------------------
  // LIST  GET /api/campaigns
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns", () => {
    it("returns an empty list when user has no campaigns", async () => {
      // Use a fresh user with no campaigns
      const freshAuth = await setupAuth(env, { email: "campaigns-empty@test.com" });
      const res = await api("GET", "/api/campaigns", { headers: freshAuth.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[] };
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it("returns campaigns with linkCount for the authenticated user", async () => {
      const campaign = await createTestCampaign(userId, { name: "List Test Campaign" });
      const link = await createTestLink(env.DB, { slug: "list-camp-link", userId });
      await linkToCampaign(link.id, campaign.id);

      const res = await api("GET", "/api/campaigns", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; name: string; linkCount: number }[] };
      const found = json.data.find((c) => c.id === campaign.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("List Test Campaign");
      expect(found!.linkCount).toBe(1);
    });

    it("does not return campaigns belonging to another user", async () => {
      const otherAuth = await setupAuth(env, { email: "campaigns-other@test.com" });
      const otherCampaign = await createTestCampaign(otherAuth.user.id, {
        name: "Other User Campaign",
      });

      const res = await api("GET", "/api/campaigns", { headers });
      const json = await res.json() as { data: { id: string }[] };
      const ids = json.data.map((c) => c.id);
      expect(ids).not.toContain(otherCampaign.id);
    });

    it("returns 401 for unauthenticated request", async () => {
      const res = await api("GET", "/api/campaigns");
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // CREATE  POST /api/campaigns
  // -------------------------------------------------------------------------
  describe("POST /api/campaigns", () => {
    it("creates a campaign with name and description", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers,
        body: { name: "My Campaign", description: "A test campaign" },
      });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { id: string; name: string; description: string } };
      expect(json.data.id).toBeTruthy();
      expect(json.data.name).toBe("My Campaign");
      expect(json.data.description).toBe("A test campaign");
    });

    it("creates a campaign with only a name", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers,
        body: { name: "Minimal Campaign" },
      });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { name: string; description: string | null } };
      expect(json.data.name).toBe("Minimal Campaign");
      expect(json.data.description).toBeNull();
    });

    it("rejects missing name with 400", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers,
        body: { description: "No name here" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty string name with 400", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers,
        body: { name: "   " },
      });
      expect(res.status).toBe(400);
    });

    it("rejects name exceeding 200 characters with 400", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers,
        body: { name: "x".repeat(201) },
      });
      expect(res.status).toBe(400);
    });

    it("rejects description exceeding 2000 characters with 400", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers,
        body: { name: "Valid Name", description: "d".repeat(2001) },
      });
      expect(res.status).toBe(400);
    });

    it("rejects oversized body with 413", async () => {
      const bigDesc = "x".repeat(11_000);
      const body = JSON.stringify({ name: "Big", description: bigDesc });
      const res = await app.request(
        "/api/campaigns",
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": String(new TextEncoder().encode(body).byteLength),
          },
          body,
        },
        env,
        mockExecutionCtx()
      );
      expect(res.status).toBe(413);
    });

    it("rejects unauthenticated request with 401", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers: { "Content-Type": "application/json" },
        body: { name: "No Auth" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET DETAIL  GET /api/campaigns/:id
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns/:id", () => {
    it("returns campaign details with an empty links array", async () => {
      const campaign = await createTestCampaign(userId, { name: "Detail Campaign" });

      const res = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; name: string; links: unknown[] } };
      expect(json.data.id).toBe(campaign.id);
      expect(json.data.name).toBe("Detail Campaign");
      expect(Array.isArray(json.data.links)).toBe(true);
      expect(json.data.links).toHaveLength(0);
    });

    it("returns campaign with associated links and their click counts", async () => {
      const campaign = await createTestCampaign(userId, { name: "Campaign With Links" });
      const link = await createTestLink(env.DB, { slug: "detail-camp-link", userId });
      await linkToCampaign(link.id, campaign.id);

      // Insert click stats for the link
      await insertClickStat(env.DB, link.id, 42, "2026-03-20", 30);

      const res = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { links: { id: string; slug: string; totalClicks: number }[] };
      };
      expect(json.data.links).toHaveLength(1);
      expect(json.data.links[0].id).toBe(link.id);
      expect(json.data.links[0].slug).toBe("detail-camp-link");
      expect(json.data.links[0].totalClicks).toBe(42);
    });

    it("returns 404 for non-existent campaign ID", async () => {
      const res = await api("GET", "/api/campaigns/nonexistent-id", { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a campaign owned by a different user", async () => {
      const otherAuth = await setupAuth(env, { email: "campaigns-iso1@test.com" });
      const otherCampaign = await createTestCampaign(otherAuth.user.id, {
        name: "Other's Campaign",
      });

      const res = await api("GET", `/api/campaigns/${otherCampaign.id}`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // UPDATE  PUT /api/campaigns/:id
  // -------------------------------------------------------------------------
  describe("PUT /api/campaigns/:id", () => {
    it("updates the campaign name", async () => {
      const campaign = await createTestCampaign(userId, { name: "Original Name" });

      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { name: "Updated Name" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { name: string } };
      expect(json.data.name).toBe("Updated Name");

      // Read back persisted state — guards against an UPDATE that only echoes the input
      const getRes = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const getJson = await getRes.json() as { data: { name: string } };
      expect(getJson.data.name).toBe("Updated Name");
    });

    it("updates the campaign description", async () => {
      const campaign = await createTestCampaign(userId, {
        name: "Desc Update",
        description: "Old description",
      });

      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { description: "New description" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { description: string } };
      expect(json.data.description).toBe("New description");

      // Read back persisted state — guards against an UPDATE that only echoes the input
      const getRes = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const getJson = await getRes.json() as { data: { description: string } };
      expect(getJson.data.description).toBe("New description");
    });

    it("partial update leaves unchanged fields intact", async () => {
      const campaign = await createTestCampaign(userId, {
        name: "Partial Update",
        description: "Keep me",
      });

      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { name: "New Name Only" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { name: string; description: string } };
      expect(json.data.name).toBe("New Name Only");
      expect(json.data.description).toBe("Keep me");
    });

    it("clears description when set to null", async () => {
      const campaign = await createTestCampaign(userId, {
        name: "Clear Desc",
        description: "Will be cleared",
      });

      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { description: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { description: string | null } };
      expect(json.data.description).toBeNull();

      // Read back persisted state — guards against an UPDATE that only echoes the input
      const getRes = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const getJson = await getRes.json() as { data: { description: string | null } };
      expect(getJson.data.description).toBeNull();
    });

    it("rejects empty name with 400", async () => {
      const campaign = await createTestCampaign(userId, { name: "Will Not Change" });

      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { name: "" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects name exceeding 200 characters with 400", async () => {
      const campaign = await createTestCampaign(userId, { name: "Long Name Test" });

      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { name: "y".repeat(201) },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent campaign", async () => {
      const res = await api("PUT", "/api/campaigns/nonexistent-id", {
        headers,
        body: { name: "Nope" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 when no body is sent", async () => {
      const campaign = await createTestCampaign(userId, { name: "No Body PUT" });

      const res = await app.request(`/api/campaigns/${campaign.id}`, {
        method: "PUT",
        headers,
      }, env, mockExecutionCtx());
      expect(res.status).toBe(400);
    });

    it("returns 404 when updating another user's campaign", async () => {
      const otherAuth = await setupAuth(env, { email: "campaigns-iso2@test.com" });
      const otherCampaign = await createTestCampaign(otherAuth.user.id, { name: "Not Mine" });

      const res = await api("PUT", `/api/campaigns/${otherCampaign.id}`, {
        headers,
        body: { name: "Hijacked" },
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE  DELETE /api/campaigns/:id
  // -------------------------------------------------------------------------
  describe("DELETE /api/campaigns/:id", () => {
    it("deletes a campaign successfully", async () => {
      const campaign = await createTestCampaign(userId, { name: "Delete Me" });

      const res = await api("DELETE", `/api/campaigns/${campaign.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(true);
    });

    it("campaign is no longer accessible after deletion", async () => {
      const campaign = await createTestCampaign(userId, { name: "Delete Then Get" });

      await api("DELETE", `/api/campaigns/${campaign.id}`, { headers });

      const res = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent campaign", async () => {
      const res = await api("DELETE", "/api/campaigns/nonexistent-id", { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 when deleting another user's campaign", async () => {
      const otherAuth = await setupAuth(env, { email: "campaigns-iso3@test.com" });
      const otherCampaign = await createTestCampaign(otherAuth.user.id, {
        name: "Other Delete",
      });

      const res = await api("DELETE", `/api/campaigns/${otherCampaign.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("deletes link_campaigns rows but preserves the links themselves", async () => {
      const campaign = await createTestCampaign(userId, { name: "Cascade Test" });
      const link1 = await createTestLink(env.DB, { slug: "cascade-link-1", userId });
      const link2 = await createTestLink(env.DB, { slug: "cascade-link-2", userId });
      await linkToCampaign(link1.id, campaign.id);
      await linkToCampaign(link2.id, campaign.id);

      // Verify link_campaigns rows exist before delete
      const before = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM link_campaigns WHERE campaignId = ?"
      ).bind(campaign.id).first<{ cnt: number }>();
      expect(before!.cnt).toBe(2);

      const res = await api("DELETE", `/api/campaigns/${campaign.id}`, { headers });
      expect(res.status).toBe(200);

      // link_campaigns rows should be gone (ON DELETE CASCADE)
      const after = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM link_campaigns WHERE campaignId = ?"
      ).bind(campaign.id).first<{ cnt: number }>();
      expect(after!.cnt).toBe(0);

      // The links themselves must still exist
      const l1 = await env.DB.prepare("SELECT id FROM links WHERE id = ?").bind(link1.id).first();
      const l2 = await env.DB.prepare("SELECT id FROM links WHERE id = ?").bind(link2.id).first();
      expect(l1).not.toBeNull();
      expect(l2).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // ADD LINKS  POST /api/campaigns/:id/links
  // -------------------------------------------------------------------------
  describe("POST /api/campaigns/:id/links", () => {
    it("adds links to a campaign", async () => {
      const campaign = await createTestCampaign(userId, { name: "Add Links Campaign" });
      const link = await createTestLink(env.DB, { slug: "add-to-camp", userId });

      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [link.id] },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(true);

      // Verify link appears in campaign detail
      const detail = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const detailJson = await detail.json() as { data: { links: { id: string }[] } };
      expect(detailJson.data.links.map((l) => l.id)).toContain(link.id);
    });

    it("is idempotent — adding the same link twice does not error", async () => {
      const campaign = await createTestCampaign(userId, { name: "Idempotent Campaign" });
      const link = await createTestLink(env.DB, { slug: "idempotent-link", userId });

      await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [link.id] },
      });
      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [link.id] },
      });
      expect(res.status).toBe(200);
    });

    it("adds multiple links at once", async () => {
      const campaign = await createTestCampaign(userId, { name: "Multi Links Campaign" });
      const link1 = await createTestLink(env.DB, { slug: "multi-link-1", userId });
      const link2 = await createTestLink(env.DB, { slug: "multi-link-2", userId });

      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [link1.id, link2.id] },
      });
      expect(res.status).toBe(200);

      const detail = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const detailJson = await detail.json() as { data: { links: { id: string }[] } };
      const ids = detailJson.data.links.map((l) => l.id);
      expect(ids).toContain(link1.id);
      expect(ids).toContain(link2.id);
    });

    it("returns 400 when no body is sent", async () => {
      const campaign = await createTestCampaign(userId, { name: "No Body Add Links" });

      const res = await app.request(`/api/campaigns/${campaign.id}/links`, {
        method: "POST",
        headers,
      }, env, mockExecutionCtx());
      expect(res.status).toBe(400);
    });

    it("rejects empty linkIds array with 400", async () => {
      const campaign = await createTestCampaign(userId, { name: "Empty LinkIds" });

      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [] },
      });
      expect(res.status).toBe(400);
    });

    it("rejects linkIds that are not an array with 400", async () => {
      const campaign = await createTestCampaign(userId, { name: "Bad LinkIds Type" });

      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: "not-an-array" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects link IDs that do not belong to the user with 400", async () => {
      const campaign = await createTestCampaign(userId, { name: "Wrong User Links" });
      const otherAuth = await setupAuth(env, { email: "campaigns-links-iso@test.com" });
      const otherLink = await createTestLink(env.DB, {
        slug: "other-user-link",
        userId: otherAuth.user.id,
      });

      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [otherLink.id] },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent campaign", async () => {
      const link = await createTestLink(env.DB, { slug: "camp-404-link", userId });

      const res = await api("POST", "/api/campaigns/nonexistent-id/links", {
        headers,
        body: { linkIds: [link.id] },
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // REMOVE LINK  DELETE /api/campaigns/:id/links/:linkId
  // -------------------------------------------------------------------------
  describe("DELETE /api/campaigns/:id/links/:linkId", () => {
    it("removes a link from a campaign", async () => {
      const campaign = await createTestCampaign(userId, { name: "Remove Link Campaign" });
      const link = await createTestLink(env.DB, { slug: "remove-from-camp", userId });
      await linkToCampaign(link.id, campaign.id);

      const res = await api("DELETE", `/api/campaigns/${campaign.id}/links/${link.id}`, {
        headers,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(true);

      // Verify link no longer appears in campaign detail
      const detail = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const detailJson = await detail.json() as { data: { links: { id: string }[] } };
      expect(detailJson.data.links.map((l) => l.id)).not.toContain(link.id);
    });

    it("succeeds even if the link was not associated with the campaign", async () => {
      const campaign = await createTestCampaign(userId, { name: "No-Op Remove" });
      const link = await createTestLink(env.DB, { slug: "not-associated", userId });

      const res = await api("DELETE", `/api/campaigns/${campaign.id}/links/${link.id}`, {
        headers,
      });
      // DELETE is idempotent — no error for non-existent association
      expect(res.status).toBe(200);
    });

    it("returns 404 for non-existent campaign", async () => {
      const link = await createTestLink(env.DB, { slug: "remove-404-link", userId });

      const res = await api("DELETE", `/api/campaigns/nonexistent-id/links/${link.id}`, {
        headers,
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when removing from another user's campaign", async () => {
      const otherAuth = await setupAuth(env, { email: "campaigns-iso4@test.com" });
      const otherCampaign = await createTestCampaign(otherAuth.user.id, {
        name: "Other Remove",
      });
      const link = await createTestLink(env.DB, { slug: "other-remove-link", userId });

      const res = await api(
        "DELETE",
        `/api/campaigns/${otherCampaign.id}/links/${link.id}`,
        { headers }
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // STATS  GET /api/campaigns/:id/stats
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns/:id/stats", () => {
    it("returns zero stats for a campaign with no links", async () => {
      const campaign = await createTestCampaign(userId, { name: "Stats Empty" });

      const res = await api("GET", `/api/campaigns/${campaign.id}/stats`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { totalClicks: number; linkCount: number; period: { days: number } };
      };
      expect(json.data.totalClicks).toBe(0);
      expect(json.data.linkCount).toBe(0);
      expect(json.data.period.days).toBe(30);
    });

    it("aggregates click stats across all campaign links", async () => {
      const campaign = await createTestCampaign(userId, { name: "Stats Aggregate" });
      const link1 = await createTestLink(env.DB, { slug: "stats-link-1", userId });
      const link2 = await createTestLink(env.DB, { slug: "stats-link-2", userId });
      await linkToCampaign(link1.id, campaign.id);
      await linkToCampaign(link2.id, campaign.id);

      const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
      await insertClickStat(env.DB, link1.id, 10, recent, 8);
      await insertClickStat(env.DB, link2.id, 20, recent, 15);

      const res = await api("GET", `/api/campaigns/${campaign.id}/stats`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { totalClicks: number; linkCount: number };
      };
      expect(json.data.totalClicks).toBe(30);
      expect(json.data.linkCount).toBe(2);
    });

    it("respects the days query parameter", async () => {
      const res = await (async () => {
        const campaign = await createTestCampaign(userId, { name: "Stats Days Param" });
        return api("GET", `/api/campaigns/${campaign.id}/stats?days=7`, { headers });
      })();
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { period: { days: number } } };
      expect(json.data.period.days).toBe(7);
    });

    it("returns 404 for non-existent campaign", async () => {
      const res = await api("GET", "/api/campaigns/nonexistent-id/stats", { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for another user's campaign stats", async () => {
      const otherAuth = await setupAuth(env, { email: "campaigns-iso5@test.com" });
      const otherCampaign = await createTestCampaign(otherAuth.user.id, { name: "Other Stats" });

      const res = await api("GET", `/api/campaigns/${otherCampaign.id}/stats`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Access filtering on campaign links
  // -------------------------------------------------------------------------
  describe("campaign links follow current access", () => {
    /** Create a team owning one link, with the given user as a member. */
    async function createTeamWithLink(memberId: string, slug: string) {
      const teamId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "INSERT INTO teams (id, name, slug, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
      ).bind(teamId, `Team ${teamId.slice(0, 8)}`, `team-${teamId.slice(0, 8)}`, now, now).run();
      await env.DB.prepare(
        "INSERT INTO team_members (teamId, userId, role, joinedAt) VALUES (?, ?, 'member', ?)"
      ).bind(teamId, memberId, now).run();

      const ownerAuth = await setupAuth(env, { email: `team-owner-${teamId.slice(0, 8)}@test.com` });
      const link = await createTestLink(env.DB, { slug, userId: ownerAuth.user.id });
      await env.DB.prepare("UPDATE links SET teamId = ? WHERE id = ?").bind(teamId, link.id).run();

      return { teamId, link };
    }

    it("drops a team link from campaign detail once membership ends", async () => {
      const campaign = await createTestCampaign(userId, { name: "Team Link Campaign" });
      const { teamId, link } = await createTeamWithLink(userId, `team-camp-${crypto.randomUUID().slice(0, 8)}`);

      const attach = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [link.id] },
      });
      expect(attach.status).toBe(200);

      const before = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const beforeJson = await before.json() as { data: { links: { id: string }[] } };
      expect(beforeJson.data.links.map((l) => l.id)).toContain(link.id);

      await env.DB.prepare("DELETE FROM team_members WHERE teamId = ? AND userId = ?")
        .bind(teamId, userId).run();

      const after = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const afterJson = await after.json() as { data: { links: { id: string }[] } };
      expect(afterJson.data.links.map((l) => l.id)).not.toContain(link.id);

      // The list count uses the same predicate, so it must drop the link too.
      const list = await api("GET", "/api/campaigns", { headers });
      const listJson = await list.json() as { data: { id: string; linkCount: number }[] };
      expect(listJson.data.find((cp) => cp.id === campaign.id)!.linkCount).toBe(0);

      // The association row itself is untouched; only the caller's view of it changed.
      const row = await env.DB.prepare(
        "SELECT linkId FROM link_campaigns WHERE campaignId = ? AND linkId = ?"
      ).bind(campaign.id, link.id).first();
      expect(row).not.toBeNull();
    });

    it("excludes inaccessible links from campaign stats", async () => {
      const campaign = await createTestCampaign(userId, { name: "Team Stats Campaign" });
      const { teamId, link } = await createTeamWithLink(userId, `team-stats-${crypto.randomUUID().slice(0, 8)}`);
      await api("POST", `/api/campaigns/${campaign.id}/links`, { headers, body: { linkIds: [link.id] } });

      const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      await insertClickStat(env.DB, link.id, 9, recent, 9);

      const before = await api("GET", `/api/campaigns/${campaign.id}/stats`, { headers });
      const beforeJson = await before.json() as { data: { totalClicks: number; linkCount: number } };
      expect(beforeJson.data.linkCount).toBe(1);
      expect(beforeJson.data.totalClicks).toBe(9);

      await env.DB.prepare("DELETE FROM team_members WHERE teamId = ? AND userId = ?")
        .bind(teamId, userId).run();

      const after = await api("GET", `/api/campaigns/${campaign.id}/stats`, { headers });
      const afterJson = await after.json() as { data: { totalClicks: number; linkCount: number } };
      expect(afterJson.data.linkCount).toBe(0);
      expect(afterJson.data.totalClicks).toBe(0);
    });

    it("campaign detail carries domainHostname for custom-domain links", async () => {
      const hostname = "campaign-domain.example.com";
      await createTestDomain(env.DB, hostname);

      const campaign = await createTestCampaign(userId, { name: "Domain Links Campaign" });
      const link = await createTestLink(env.DB, {
        slug: `camp-dom-${crypto.randomUUID().slice(0, 8)}`,
        userId,
        domainHostname: hostname,
      });
      await linkToCampaign(link.id, campaign.id);

      const res = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const json = await res.json() as { data: { links: { id: string; domainHostname: string | null }[] } };
      expect(json.data.links.find((l) => l.id === link.id)!.domainHostname).toBe(hostname);
    });
  });

  describe("body type validation", () => {
    it("rejects a non-string description on create with 400", async () => {
      const res = await api("POST", "/api/campaigns", {
        headers,
        body: { name: "Bad Description", description: { text: "nope" } },
      });
      expect(res.status).toBe(400);
    });

    it("rejects a non-string description on update with 400", async () => {
      const campaign = await createTestCampaign(userId, { name: "Bad Update Description" });
      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { description: 42 },
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-string linkIds entries with 400", async () => {
      const campaign = await createTestCampaign(userId, { name: "Bad LinkIds Entries" });
      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [123] },
      });
      expect(res.status).toBe(400);
    });
  });
});
