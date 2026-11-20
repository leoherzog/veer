import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  setupAuth, newUser, createTestLink, createTestDomain, createTeamLink, removeTestTeamMember, api, insertClickStat, isoDaysAgo,
} from "../helpers";
import { getDb } from "../../src/db";
import { campaigns, linkCampaigns } from "../../src/db/schema";
import { CAMPAIGN_LINKS_MAX } from "../../src/lib/limits";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a campaign directly into D1. */
async function createTestCampaign(userId: string, overrides: { name?: string; description?: string | null } = {}) {
  const now = new Date();
  return getDb(env.DB).insert(campaigns).values({
    id: crypto.randomUUID(),
    userId,
    name: overrides.name ?? "Campaign",
    description: overrides.description ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning().get();
}

/** Associate a link with a campaign directly in D1. */
async function linkToCampaign(linkId: string, campaignId: string) {
  await getDb(env.DB).insert(linkCampaigns).values({ linkId, campaignId }).onConflictDoNothing();
}

/** A campaign's name and link count, or undefined once the row is gone. */
async function campaignState(id: string) {
  const db = getDb(env.DB);
  const row = await db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, id)).get();
  return row && { name: row.name, links: await db.$count(linkCampaigns, eq(linkCampaigns.campaignId, id)) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Campaigns API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
    headers = auth.headers;
    userId = auth.user.id;
  });

  // -------------------------------------------------------------------------
  // LIST  GET /api/campaigns
  // -------------------------------------------------------------------------
  describe("GET /api/campaigns", () => {
    it("returns an empty list when user has no campaigns", async () => {
      const fresh = await newUser("campaigns-empty");
      const res = await api("GET", "/api/campaigns", { headers: fresh.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[] };
      expect(json.data).toEqual([]);
    });

    it("returns campaigns with linkCount for the authenticated user", async () => {
      const campaign = await createTestCampaign(userId, { name: "List Test Campaign" });
      const link = await createTestLink({ userId });
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
      const other = await newUser("campaigns-other");
      const otherCampaign = await createTestCampaign(other.user.id, { name: "Other User Campaign" });

      const res = await api("GET", "/api/campaigns", { headers });
      const json = await res.json() as { data: { id: string }[] };
      const ids = json.data.map((c) => c.id);
      expect(ids).not.toContain(otherCampaign.id);
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
  });

  // -------------------------------------------------------------------------
  // Validation: every rejected body answers 400 with its message
  // -------------------------------------------------------------------------
  describe("validation", () => {
    let campaignId: string;

    beforeAll(async () => {
      campaignId = (await createTestCampaign(userId, { name: "Validation Target" })).id;
    });

    // `:id` is replaced with a campaign the caller owns.
    it.each<[string, string, string, unknown, string]>([
      ["a missing name on create", "POST", "", { description: "No name here" }, "name is required"],
      ["a blank name on create", "POST", "", { name: "   " }, "name is required"],
      ["a name over 200 characters on create", "POST", "", { name: "x".repeat(201) }, "name must be 200 characters or fewer"],
      ["a description over 2000 characters on create", "POST", "", { name: "Valid Name", description: "d".repeat(2001) }, "description must be 2000 characters or fewer"],
      ["a non-string description on create", "POST", "", { name: "Bad Description", description: { text: "nope" } }, "description must be a string"],
      ["no body on update", "PUT", "/:id", undefined, "Invalid JSON body"],
      ["an empty name on update", "PUT", "/:id", { name: "" }, "name is required"],
      ["a name over 200 characters on update", "PUT", "/:id", { name: "y".repeat(201) }, "name must be 200 characters or fewer"],
      ["a non-string description on update", "PUT", "/:id", { description: 42 }, "description must be a string"],
      ["no body on add links", "POST", "/:id/links", undefined, "Invalid JSON body"],
      ["an empty linkIds array", "POST", "/:id/links", { linkIds: [] }, "linkIds must be a non-empty array"],
      ["a non-array linkIds", "POST", "/:id/links", { linkIds: "not-an-array" }, "linkIds must be a non-empty array"],
      ["non-string linkIds entries", "POST", "/:id/links", { linkIds: [123] }, "linkIds must contain strings"],
      [
        "more than CAMPAIGN_LINKS_MAX linkIds",
        "POST",
        "/:id/links",
        { linkIds: Array.from({ length: CAMPAIGN_LINKS_MAX + 1 }, (_, i) => `link-${i}`) },
        `linkIds must contain ${CAMPAIGN_LINKS_MAX} or fewer items`,
      ],
    ])("rejects %s", async (_label, method, suffix, body, error) => {
      const res = await api(method, `/api/campaigns${suffix.replace(":id", campaignId)}`, { headers, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    });

    it("rejects link IDs that do not belong to the user", async () => {
      const other = await newUser("campaigns-links-iso");
      const otherLink = await createTestLink({ userId: other.user.id });

      const res = await api("POST", `/api/campaigns/${campaignId}/links`, {
        headers,
        body: { linkIds: [otherLink.id] },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `Links not found: ${otherLink.id}` });
    });
  });

  // -------------------------------------------------------------------------
  // Every /:id route 404s a missing campaign and another user's campaign
  // -------------------------------------------------------------------------
  describe("campaign not found", () => {
    let foreignId: string;
    let linkId: string;

    beforeAll(async () => {
      const other = await newUser("campaigns-foreign");
      foreignId = (await createTestCampaign(other.user.id, { name: "Not Mine" })).id;
      linkId = (await createTestLink({ userId })).id;
    });

    const routes: [string, string, (linkId: string) => unknown][] = [
      ["GET", "", () => undefined],
      ["PUT", "", () => ({ name: "Hijacked" })],
      ["DELETE", "", () => undefined],
      ["POST", "/links", (id) => ({ linkIds: [id] })],
      ["DELETE", "/links/:linkId", () => undefined],
      ["GET", "/stats", () => undefined],
    ];
    const cases = routes.flatMap(([method, suffix, body]) => (["a missing", "another user's"] as const)
      .map((whose) => [method, suffix, whose, body] as const));

    it.each(cases)("%s /api/campaigns/:id%s 404s %s campaign", async (method, suffix, whose, body) => {
      const id = whose === "a missing" ? "nonexistent-id" : foreignId;
      const res = await api(method, `/api/campaigns/${id}${suffix.replace(":linkId", linkId)}`, { headers, body: body(linkId) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Campaign not found" });
      expect(await campaignState(foreignId)).toEqual({ name: "Not Mine", links: 0 });
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
      expect(json.data.links).toEqual([]);
    });

    it("returns campaign with associated links and their click counts", async () => {
      const campaign = await createTestCampaign(userId, { name: "Campaign With Links" });
      const link = await createTestLink({ userId });
      await linkToCampaign(link.id, campaign.id);
      await insertClickStat(link.id, 42, "2026-03-20");

      const res = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { links: { id: string; slug: string; totalClicks: number }[] };
      };
      expect(json.data.links).toHaveLength(1);
      expect(json.data.links[0].id).toBe(link.id);
      expect(json.data.links[0].slug).toBe(link.slug);
      expect(json.data.links[0].totalClicks).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // UPDATE  PUT /api/campaigns/:id
  // -------------------------------------------------------------------------
  describe("PUT /api/campaigns/:id", () => {
    it("updates the name and leaves the description intact", async () => {
      const campaign = await createTestCampaign(userId, { name: "Original Name", description: "Keep me" });

      const res = await api("PUT", `/api/campaigns/${campaign.id}`, {
        headers,
        body: { name: "Updated Name" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { name: string; description: string } };
      expect(json.data.name).toBe("Updated Name");
      expect(json.data.description).toBe("Keep me");

      // Read back persisted state — guards against an UPDATE that only echoes the input
      const getRes = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const getJson = await getRes.json() as { data: { name: string; description: string } };
      expect(getJson.data.name).toBe("Updated Name");
      expect(getJson.data.description).toBe("Keep me");
    });

    it("updates the campaign description", async () => {
      const campaign = await createTestCampaign(userId, { name: "Desc Update", description: "Old description" });

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

    it("clears description when set to null", async () => {
      const campaign = await createTestCampaign(userId, { name: "Clear Desc", description: "Will be cleared" });

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
  });

  // -------------------------------------------------------------------------
  // DELETE  DELETE /api/campaigns/:id
  // -------------------------------------------------------------------------
  describe("DELETE /api/campaigns/:id", () => {
    it("deletes a campaign, which then 404s", async () => {
      const campaign = await createTestCampaign(userId, { name: "Delete Me" });

      const res = await api("DELETE", `/api/campaigns/${campaign.id}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      const getRes = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      expect(getRes.status).toBe(404);
    });

    it("deletes link_campaigns rows but preserves the links themselves", async () => {
      const campaign = await createTestCampaign(userId, { name: "Cascade Test" });
      const link1 = await createTestLink({ userId });
      const link2 = await createTestLink({ userId });
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
      const link = await createTestLink({ userId });

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
      const link = await createTestLink({ userId });

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
      const link1 = await createTestLink({ userId });
      const link2 = await createTestLink({ userId });

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

    it("adds CAMPAIGN_LINKS_MAX links in one request", async () => {
      const campaign = await createTestCampaign(userId, { name: "Max Links Campaign" });
      const links = await Promise.all(Array.from({ length: CAMPAIGN_LINKS_MAX }, () => createTestLink({ userId })));

      const res = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: links.map(l => l.id) },
      });
      expect(res.status).toBe(200);

      const row = await env.DB.prepare("SELECT count(*) AS n FROM link_campaigns WHERE campaignId = ?")
        .bind(campaign.id).first<{ n: number }>();
      expect(row!.n).toBe(CAMPAIGN_LINKS_MAX);
    });
  });

  // -------------------------------------------------------------------------
  // REMOVE LINK  DELETE /api/campaigns/:id/links/:linkId
  // -------------------------------------------------------------------------
  describe("DELETE /api/campaigns/:id/links/:linkId", () => {
    it("removes a link from a campaign", async () => {
      const campaign = await createTestCampaign(userId, { name: "Remove Link Campaign" });
      const link = await createTestLink({ userId });
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
      const link = await createTestLink({ userId });

      const res = await api("DELETE", `/api/campaigns/${campaign.id}/links/${link.id}`, {
        headers,
      });
      // DELETE is idempotent — no error for non-existent association
      expect(res.status).toBe(200);
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
      const link1 = await createTestLink({ userId });
      const link2 = await createTestLink({ userId });
      await linkToCampaign(link1.id, campaign.id);
      await linkToCampaign(link2.id, campaign.id);

      const recent = isoDaysAgo(5);
      await insertClickStat(link1.id, 10, recent);
      await insertClickStat(link2.id, 20, recent);

      const res = await api("GET", `/api/campaigns/${campaign.id}/stats`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { totalClicks: number; linkCount: number };
      };
      expect(json.data.totalClicks).toBe(30);
      expect(json.data.linkCount).toBe(2);
    });

    it("counts only clicks inside the days window", async () => {
      const campaign = await createTestCampaign(userId, { name: "Stats Days Window" });
      const recentLink = await createTestLink({ userId });
      const oldLink = await createTestLink({ userId });
      await linkToCampaign(recentLink.id, campaign.id);
      await linkToCampaign(oldLink.id, campaign.id);
      await insertClickStat(recentLink.id, 3, isoDaysAgo(2));
      await insertClickStat(oldLink.id, 11, isoDaysAgo(10));

      const res = await api("GET", `/api/campaigns/${campaign.id}/stats?days=7`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalClicks: number; linkCount: number; period: { days: number } } };
      expect(json.data.totalClicks).toBe(3);
      expect(json.data.linkCount).toBe(2);
      expect(json.data.period.days).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // Access filtering on campaign links
  // -------------------------------------------------------------------------
  describe("campaign links follow current access", () => {
    it("drops a team link from campaign detail once membership ends", async () => {
      const campaign = await createTestCampaign(userId, { name: "Team Link Campaign" });
      const { team, link } = await createTeamLink(userId);

      const attach = await api("POST", `/api/campaigns/${campaign.id}/links`, {
        headers,
        body: { linkIds: [link.id] },
      });
      expect(attach.status).toBe(200);

      const before = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const beforeJson = await before.json() as { data: { links: { id: string }[] } };
      expect(beforeJson.data.links.map((l) => l.id)).toContain(link.id);

      await removeTestTeamMember(team.id, userId);

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
      const { team, link } = await createTeamLink(userId);
      await api("POST", `/api/campaigns/${campaign.id}/links`, { headers, body: { linkIds: [link.id] } });
      await insertClickStat(link.id, 9, isoDaysAgo(2));

      const before = await api("GET", `/api/campaigns/${campaign.id}/stats`, { headers });
      const beforeJson = await before.json() as { data: { totalClicks: number; linkCount: number } };
      expect(beforeJson.data.linkCount).toBe(1);
      expect(beforeJson.data.totalClicks).toBe(9);

      await removeTestTeamMember(team.id, userId);

      const after = await api("GET", `/api/campaigns/${campaign.id}/stats`, { headers });
      const afterJson = await after.json() as { data: { totalClicks: number; linkCount: number } };
      expect(afterJson.data.linkCount).toBe(0);
      expect(afterJson.data.totalClicks).toBe(0);
    });

    it("campaign detail carries domainHostname for custom-domain links", async () => {
      const hostname = "campaign-domain.example.com";
      await createTestDomain(hostname);

      const campaign = await createTestCampaign(userId, { name: "Domain Links Campaign" });
      const link = await createTestLink({ userId, domainHostname: hostname });
      await linkToCampaign(link.id, campaign.id);

      const res = await api("GET", `/api/campaigns/${campaign.id}`, { headers });
      const json = await res.json() as { data: { links: { id: string; domainHostname: string | null }[] } };
      expect(json.data.links.find((l) => l.id === link.id)!.domainHostname).toBe(hostname);
    });
  });
});
