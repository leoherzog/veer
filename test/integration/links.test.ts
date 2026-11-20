import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import {
  setupAuth, createTestLink, createTestTeam, addTestTeamMember, api, postLink, newUser, uniq, insertClickStat, type JsonBody,
} from "../helpers";
import { hashPassword } from "../../src/services/password";
import { DEVICE_TYPES } from "../../src/services/useragent";
import { CAMPAIGN_LINKS_MAX } from "../../src/lib/limits";

/** Create a campaign through the API and return its id. */
async function createCampaign(headers: Record<string, string>, name = "Campaign"): Promise<string> {
  const res = await api("POST", "/api/campaigns", { headers, body: { name } });
  expect(res.status).toBe(201);
  return (await res.json() as { data: { id: string } }).data.id;
}

/** The campaign ids associated with a link, sorted. */
async function linkCampaignIds(linkId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT campaignId FROM link_campaigns WHERE linkId = ?")
    .bind(linkId).all<{ campaignId: string }>();
  return results.map(r => r.campaignId).sort();
}

/** The ids of a link list response, in order. */
async function listIds(res: Response): Promise<string[]> {
  return (await res.json() as { data: { id: string }[] }).data.map(l => l.id);
}

const tooManyIds = Array.from({ length: CAMPAIGN_LINKS_MAX + 1 }, (_, i) => `campaign-${i}`);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Links API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
    headers = auth.headers;
    userId = auth.user.id;
  });

  // -----------------------------------------------------------------------
  // LIST  GET /api/links
  // -----------------------------------------------------------------------
  describe("GET /api/links", () => {
    it("lists only the authenticated user's links", async () => {
      const mine = await createTestLink({ userId });
      const other = await newUser("other-list");
      const theirs = await createTestLink({ userId: other.user.id });

      const ids = await listIds(await api("GET", "/api/links", { headers }));
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });

    it("paginates correctly", async () => {
      for (let i = 0; i < 3; i++) {
        await createTestLink({ userId });
      }

      const res = await api("GET", "/api/links?page=1&limit=2", { headers });
      const json = await res.json() as { data: unknown[]; pagination: { page: number; limit: number; total: number } };
      expect(json.data).toHaveLength(2);
      expect(json.pagination.page).toBe(1);
      expect(json.pagination.limit).toBe(2);
    });

    it("searches by slug substring", async () => {
      await createTestLink({ slug: "findme-slug", userId });
      const res = await api("GET", "/api/links?q=findme", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      expect(json.data.some((l) => l.slug === "findme-slug")).toBe(true);
    });

    it("searches by title substring", async () => {
      await createTestLink({ userId, title: "UniqueTitle42" });
      const res = await api("GET", "/api/links?q=UniqueTitle42", { headers });
      const json = await res.json() as { data: { title: string }[] };
      expect(json.data.some((l) => l.title === "UniqueTitle42")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // CREATE  POST /api/links
  // -----------------------------------------------------------------------
  describe("POST /api/links", () => {
    it("creates a link with all fields", async () => {
      const res = await postLink(
        { slug: "full-link", destinationUrl: "https://example.com/full", redirectType: 301, title: "Full" },
        headers
      );
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { slug: string; redirectType: number; title: string } };
      expect(json.data.slug).toBe("full-link");
      expect(json.data.redirectType).toBe(301);
      expect(json.data.title).toBe("Full");
    });

    it("creates a link with minimal fields", async () => {
      const res = await postLink(
        { slug: "minimal", destinationUrl: "https://example.com/min" },
        headers
      );
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { slug: string; redirectType: number; title: string | null } };
      expect(json.data.slug).toBe("minimal");
      expect(json.data.redirectType).toBe(302);
      expect(json.data.title).toBeNull();
    });

    it("rejects duplicate slug with 409", async () => {
      const taken = await createTestLink({ userId });
      const res = await postLink({ slug: taken.slug, destinationUrl: "https://example.com" }, headers);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Slug already taken" });
    });

    it("stores the slug lowercased", async () => {
      const res = await postLink(
        { slug: "MixedCase-Slug", destinationUrl: "https://example.com" },
        headers
      );
      expect(res.status).toBe(201);
      const json = await res.json() as JsonBody;
      expect((json.data as JsonBody).slug).toBe("mixedcase-slug");

      const row = await env.DB.prepare("SELECT slug FROM links WHERE id = ?")
        .bind((json.data as JsonBody).id).first<{ slug: string }>();
      expect(row?.slug).toBe("mixedcase-slug");
    });

    it("rejects a case variant of an existing slug with 409", async () => {
      await createTestLink({ slug: "case-taken", userId });
      const res = await postLink(
        { slug: "Case-TAKEN", destinationUrl: "https://example.com" },
        headers
      );
      expect(res.status).toBe(409);
    });

    it("accepts an emoji slug and stores it decoded", async () => {
      const res = await postLink(
        { slug: "%F0%9F%8E%89-party", destinationUrl: "https://example.com/emoji" },
        headers
      );
      expect(res.status).toBe(201);
      const json = await res.json() as JsonBody;
      expect((json.data as JsonBody).slug).toBe("\u{1F389}-party");
    });

    it("creates the link with its campaign associations", async () => {
      const first = await createCampaign(headers, "Create First");
      const second = await createCampaign(headers, "Create Second");

      const res = await postLink({
        slug: uniq("post-campaigns"),
        destinationUrl: "https://example.com",
        campaignIds: [first, second, first],
      }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { id: string } };
      expect(await linkCampaignIds(json.data.id)).toEqual([first, second].sort());
    });

    const url = "https://example.com";
    const SLUG_CHARS_ERROR = "Slug may only contain";
    it.each<[string, unknown, string]>([
      ["no body", undefined, "Invalid JSON body"],
      ["a non-object body", 42, "Invalid link entry"],
      ["a missing slug", { destinationUrl: url }, "Slug is required"],
      ["a missing destinationUrl", { slug: uniq("no-dest") }, "destinationUrl is required"],
      ["a non-http(s) URL", { slug: uniq("ftp"), destinationUrl: "ftp://files.example.com/data" }, "destinationUrl must be an absolute http or https URL"],
      ["a reserved slug", { slug: "api", destinationUrl: url }, "This slug is reserved"],
      ...["has space", "has/slash", "has?query", "has#hash", "has%percent", "has<angle"].map(
        (slug): [string, unknown, string] => [`the URL-unsafe slug ${JSON.stringify(slug)}`, { slug, destinationUrl: url }, SLUG_CHARS_ERROR],
      ),
      ["a non-http ogImage", { slug: uniq("og"), destinationUrl: url, ogImage: "ftp://files.example.com/image.png" }, "ogImage must be an absolute http or https URL"],
      ["an expiresAt in the past", { slug: uniq("exp"), destinationUrl: url, expiresAt: "2020-01-01T00:00:00Z" }, "expiresAt must be in the future"],
      ["an unparseable expiresAt", { slug: uniq("exp"), destinationUrl: url, expiresAt: "not-a-date" }, "Invalid expiresAt date"],
      ["maxClicks 0", { slug: uniq("mc"), destinationUrl: url, maxClicks: 0 }, "maxClicks must be a positive integer"],
      ["maxClicks -1", { slug: uniq("mc"), destinationUrl: url, maxClicks: -1 }, "maxClicks must be a positive integer"],
      ["a non-string title", { slug: uniq("title"), destinationUrl: url, title: 42 }, "title must be a string"],
      ["a non-string password", { slug: uniq("pw"), destinationUrl: url, password: 12345 }, "password must be a string"],
      ["a non-array campaignIds", { slug: uniq("cids"), destinationUrl: url, campaignIds: "nope" }, "campaignIds must be an array"],
      ["more than CAMPAIGN_LINKS_MAX campaignIds", { slug: uniq("cids"), destinationUrl: url, campaignIds: tooManyIds }, `campaignIds must contain ${CAMPAIGN_LINKS_MAX} or fewer items`],
      ["an unknown campaignId", { slug: uniq("cids"), destinationUrl: url, campaignIds: ["no-such-campaign"] }, "Campaign not found or does not belong to you"],
    ])("rejects %s with 400 and creates nothing", async (_label, body, error) => {
      const res = await api("POST", "/api/links", { headers, body });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain(error);

      const slug = (body as { slug?: unknown } | undefined)?.slug;
      if (typeof slug === "string") {
        expect(await env.DB.prepare("SELECT id FROM links WHERE slug = ?").bind(slug).first()).toBeNull();
      }
    });
  });

  // -----------------------------------------------------------------------
  // CREATE a team-owned link
  // -----------------------------------------------------------------------
  describe("POST /api/links with teamId", () => {
    it("creates the link with its teamId for a team member", async () => {
      const team = await createTestTeam(userId, "member");

      const res = await postLink({ slug: uniq("team-create"), destinationUrl: "https://example.com/team", teamId: team.id }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { id: string; teamId: string | null } };
      expect(json.data.teamId).toBe(team.id);

      const row = await env.DB.prepare("SELECT teamId FROM links WHERE id = ?")
        .bind(json.data.id).first<{ teamId: string | null }>();
      expect(row!.teamId).toBe(team.id);
    });

    it("404s a non-member and inserts nothing", async () => {
      const outsider = await newUser("team-outsider");
      const team = await createTestTeam(outsider.user.id);
      const slug = uniq("team-denied");

      const res = await postLink({ slug, destinationUrl: "https://example.com/team", teamId: team.id }, headers);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Team not found" });
      expect(await env.DB.prepare("SELECT id FROM links WHERE slug = ?").bind(slug).first()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // GET BY ID  GET /api/links/:id
  // -----------------------------------------------------------------------
  describe("GET /api/links/:id", () => {
    it("returns a link with totalClicks=0 when no stats exist", async () => {
      const link = await createTestLink({ userId });
      const res = await api("GET", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; totalClicks: number } };
      expect(json.data.id).toBe(link.id);
      expect(json.data.totalClicks).toBe(0);
    });

    it("returns aggregated totalClicks from link_stats", async () => {
      const link = await createTestLink({ userId });
      await insertClickStat(link.id, 15, "2026-03-15");
      await insertClickStat(link.id, 25, "2026-03-16");

      const res = await api("GET", `/api/links/${link.id}`, { headers });
      const json = await res.json() as { data: { totalClicks: number } };
      expect(json.data.totalClicks).toBe(40);
    });
  });

  // -----------------------------------------------------------------------
  // Every /:id route 404s a link that does not exist
  // -----------------------------------------------------------------------
  describe("non-existent link", () => {
    it.each<[string, string, unknown]>([
      ["GET", "", undefined],
      ["PUT", "", { title: "Nope" }],
      ["DELETE", "", undefined],
      ["PUT", "/targets", { targets: [] }],
    ])("%s /api/links/:id%s returns 404", async (method, suffix, body) => {
      const res = await api(method, `/api/links/nonexistent-id${suffix}`, { headers, body });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Link not found" });
    });
  });

  // -----------------------------------------------------------------------
  // UPDATE  PUT /api/links/:id
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id", () => {
    it("updates the destination URL", async () => {
      const link = await createTestLink({ userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { destinationUrl: "https://new-destination.com" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { destinationUrl: string } };
      expect(json.data.destinationUrl).toBe("https://new-destination.com");
    });

    it("updates the title and ignores a slug in the body, even a taken one", async () => {
      const taken = await createTestLink({ userId });
      const link = await createTestLink({ userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { slug: taken.slug, title: "Updated" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { slug: string; title: string } };
      expect(json.data.slug).toBe(link.slug);
      expect(json.data.title).toBe("Updated");
    });

    describe("validation", () => {
      let linkId: string;

      beforeAll(async () => {
        linkId = (await createTestLink({ userId })).id;
      });

      it.each<[string, string, unknown, string]>([
        ["no body", "", undefined, "Invalid JSON body"],
        ["no body on targets", "/targets", undefined, "Invalid JSON body"],
        ["a non-string title", "", { title: 42 }, "title must be a string"],
        ["a non-string password", "", { password: { hash: "x" } }, "password must be a string"],
        ["a non-array campaignIds", "", { campaignIds: "not-an-array" }, "campaignIds must be an array"],
        ["more than CAMPAIGN_LINKS_MAX campaignIds", "", { campaignIds: tooManyIds }, `campaignIds must contain ${CAMPAIGN_LINKS_MAX} or fewer items`],
      ])("rejects %s with 400", async (_label, suffix, body, error) => {
        const res = await api("PUT", `/api/links/${linkId}${suffix}`, { headers, body });
        expect(res.status).toBe(400);
        expect((await res.json() as { error: string }).error).toContain(error);
      });
    });

    it("a bogus campaignId leaves D1 and KV untouched", async () => {
      const link = await createTestLink({ userId, destinationUrl: "https://original.example.com" });
      await env.KV.put(link.slug, JSON.stringify({ url: "https://original.example.com", linkId: link.id }));

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { destinationUrl: "https://changed.example.com", campaignIds: ["no-such-campaign"] },
      });
      expect(res.status).toBe(400);

      const row = await env.DB.prepare("SELECT destinationUrl FROM links WHERE id = ?")
        .bind(link.id).first<{ destinationUrl: string }>();
      expect(row!.destinationUrl).toBe("https://original.example.com");

      const cached = await env.KV.get(link.slug, { type: "json" }) as { url: string };
      expect(cached.url).toBe("https://original.example.com");
    });
  });

  // -----------------------------------------------------------------------
  // DELETE  DELETE /api/links/:id
  // -----------------------------------------------------------------------
  describe("DELETE /api/links/:id", () => {
    it("returns success, clears the cache entry and 404s on re-fetch", async () => {
      const link = await createTestLink({ userId });
      await env.KV.put(link.slug, JSON.stringify({ url: link.destinationUrl, linkId: link.id }));

      const res = await api("DELETE", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(await env.KV.get(link.slug)).toBeNull();

      const refetch = await api("GET", `/api/links/${link.id}`, { headers });
      expect(refetch.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Link create with advanced fields
  // -----------------------------------------------------------------------
  describe("POST /api/links – advanced fields", () => {
    it("creates link with OG fields", async () => {
      const res = await postLink({
        slug: uniq("og-link"),
        destinationUrl: "https://example.com/og",
        ogTitle: "My Title",
        ogDescription: "My Description",
        ogImage: "https://example.com/image.png",
      }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { ogTitle: string; ogDescription: string; ogImage: string } };
      expect(json.data.ogTitle).toBe("My Title");
      expect(json.data.ogDescription).toBe("My Description");
      expect(json.data.ogImage).toBe("https://example.com/image.png");
    });

    it("creates link with password (hasPassword: true, no hash in response)", async () => {
      const res = await postLink({
        slug: uniq("pw-create"),
        destinationUrl: "https://example.com",
        password: "mysecret",
      }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { hasPassword: boolean; password?: string } };
      expect(json.data.hasPassword).toBe(true);
      expect(json.data).not.toHaveProperty("password");
    });

    it("creates link with isInternal: true", async () => {
      const res = await postLink({
        slug: uniq("internal"),
        destinationUrl: "https://example.com",
        isInternal: true,
      }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { isInternal: boolean } };
      expect(json.data.isInternal).toBe(true);
    });

    it("creates link with paramForwarding: true", async () => {
      const res = await postLink({
        slug: uniq("paramfwd"),
        destinationUrl: "https://example.com",
        paramForwarding: true,
      }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { paramForwarding: boolean } };
      expect(json.data.paramForwarding).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Link update clearing fields
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id – clearing fields", () => {
    it("clears expiresAt with null", async () => {
      const link = await createTestLink({ userId, expiresAt: new Date(Date.now() + 86_400_000) });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { expiresAt: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { expiresAt: unknown } };
      expect(json.data.expiresAt).toBeNull();
    });

    it("clears maxClicks with null", async () => {
      const link = await createTestLink({ userId, maxClicks: 100 });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { maxClicks: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { maxClicks: unknown } };
      expect(json.data.maxClicks).toBeNull();
    });

    it("clears password with empty string", async () => {
      const link = await createTestLink({ userId, password: await hashPassword("secret") });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { password: "" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hasPassword: boolean } };
      expect(json.data.hasPassword).toBe(false);
    });

    it("clears ogImage with null", async () => {
      const link = await createTestLink({ userId, ogImage: "https://example.com/img.png" });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { ogImage: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { ogImage: unknown } };
      expect(json.data.ogImage).toBeNull();
    });

    it("toggles isInternal and paramForwarding", async () => {
      const link = await createTestLink({ userId });

      const res1 = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { isInternal: true, paramForwarding: true },
      });
      expect(res1.status).toBe(200);
      const json1 = await res1.json() as { data: { isInternal: boolean; paramForwarding: boolean } };
      expect(json1.data.isInternal).toBe(true);
      expect(json1.data.paramForwarding).toBe(true);

      const res2 = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { isInternal: false, paramForwarding: false },
      });
      expect(res2.status).toBe(200);
      const json2 = await res2.json() as { data: { isInternal: boolean; paramForwarding: boolean } };
      expect(json2.data.isInternal).toBe(false);
      expect(json2.data.paramForwarding).toBe(false);
    });

    it("changes redirectType from 302 to 301", async () => {
      const link = await createTestLink({ userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { redirectType: 301 },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { redirectType: number } };
      expect(json.data.redirectType).toBe(301);
    });
  });

  // -----------------------------------------------------------------------
  // Target validation errors
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id/targets – validation", () => {
    let targetLinkId: string;

    beforeAll(async () => {
      targetLinkId = (await createTestLink({ userId })).id;
    });

    const dest = "https://example.com";
    const AB_WEIGHT_ERROR = "A/B weight must be an integer between 1 and 99";
    it.each<[string, unknown, string]>([
      ["targets not an array", "not-array", "targets must be an array"],
      ["an unknown type", [{ type: "browser", matchValue: "chrome", destinationUrl: dest }], "Invalid target type. Must be one of: geo, device, ab"],
      ["an empty matchValue", [{ type: "geo", matchValue: "", destinationUrl: dest }], "matchValue is required"],
      ["a geo matchValue that is not 2 letters", [{ type: "geo", matchValue: "USA", destinationUrl: dest }], "Geo matchValue must be a 2-letter ISO country code"],
      ["a device matchValue outside DEVICE_TYPES", [{ type: "device", matchValue: "phone", destinationUrl: dest }], `Device matchValue must be one of: ${DEVICE_TYPES.join(", ")}`],
      ["a non-http(s) destinationUrl", [{ type: "geo", matchValue: "US", destinationUrl: "ftp://bad.com" }], "destinationUrl must be an absolute http or https URL"],
      ["a null entry", [null], "Each target must be an object"],
      ["a string entry", ["geo"], "Each target must be an object"],
      ["an inherited property as the type", [{ type: "constructor", matchValue: "x", destinationUrl: dest }], "Invalid target type"],
      ["a non-string matchValue", [{ type: "geo", matchValue: 42, destinationUrl: dest }], "matchValue is required"],
      ["an A/B weight of 0", [{ type: "ab", matchValue: "0", destinationUrl: dest }], AB_WEIGHT_ERROR],
      ["an A/B weight of 100", [{ type: "ab", matchValue: "100", destinationUrl: dest }], AB_WEIGHT_ERROR],
      ["A/B weights summing to 100", [
        { type: "ab", matchValue: "60", destinationUrl: "https://example.com/a" },
        { type: "ab", matchValue: "40", destinationUrl: "https://example.com/b" },
      ], "A/B variant weights must sum to less than 100"],
    ])("rejects %s", async (_label, targets, error) => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, { headers, body: { targets } });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain(error);
    });

    it("accepts every DEVICE_TYPES value and stores it trimmed and lowercased", async () => {
      const targets = DEVICE_TYPES.map(device => ({
        type: "device", matchValue: ` ${device.toUpperCase()} `, destinationUrl: `https://example.com/${device}`,
      }));
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, { headers, body: { targets } });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { matchValue: string }[] };
      expect(json.data.map(t => t.matchValue)).toEqual([...DEVICE_TYPES]);

      const { results } = await env.DB
        .prepare("SELECT matchValue FROM link_targets WHERE linkId = ? AND type = 'device'")
        .bind(targetLinkId)
        .all<{ matchValue: string }>();
      expect(results.map(r => r.matchValue).sort()).toEqual([...DEVICE_TYPES].sort());
    });

    it("persists an A/B target — type 'ab' must satisfy the DB CHECK", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [{ type: "ab", matchValue: "50", destinationUrl: "https://example.com/variant-b" }] },
      });
      expect(res.status).toBe(200);

      const row = await env.DB
        .prepare("SELECT type, matchValue FROM link_targets WHERE linkId = ? AND type = 'ab'")
        .bind(targetLinkId)
        .first<{ type: string; matchValue: string }>();
      expect(row).not.toBeNull();
      expect(row!.matchValue).toBe("50");
    });

    it("clears all rules with empty array", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [] },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[] };
      expect(json.data).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Search SQL wildcard escaping
  // -----------------------------------------------------------------------
  describe("GET /api/links – search wildcard escaping", () => {
    it("search for % matches a literal percent and does not act as a wildcard", async () => {
      const unique = uniq("pct");
      const percentSlug = `has-percent-${unique}%sign`;
      const normalSlug = `normal-link-${unique}`;
      await createTestLink({ slug: percentSlug, userId });
      await createTestLink({ slug: normalSlug, userId });

      // ?q=%25 decodes to a single literal "%". With correct LIKE escaping this
      // matches only slugs containing a literal "%", not every row (which is what
      // an unescaped "%" wildcard would return).
      const res = await api("GET", "/api/links?q=%25", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      const slugs = json.data.map((l) => l.slug);

      // Positive: the literal-% slug is found, so over-aggressive escaping cannot pass vacuously.
      expect(slugs).toContain(percentSlug);
      // Negative: a slug without a "%" is NOT returned, proving "%" is not a wildcard.
      expect(slugs).not.toContain(normalSlug);
      // Every result must contain a literal "%".
      for (const item of json.data) {
        expect(item.slug).toContain("%");
      }
    });

    it("search for _ matches a literal underscore and does not act as a single-char wildcard", async () => {
      const unique = uniq("us");
      const literalSlug = `has_underscore_${unique}`;
      // Under an unescaped LIKE, "_underscore_" is <any><literal "underscore"><any>,
      // which would match this slug even though it has no "_" characters. Correct
      // escaping treats "_" literally, so this control must be excluded.
      const wildcardOnlySlug = `zunderscorez${unique}`;
      await createTestLink({ slug: literalSlug, userId });
      await createTestLink({ slug: wildcardOnlySlug, userId });

      const res = await api("GET", "/api/links?q=_underscore_", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      const slugs = json.data.map((l) => l.slug);

      expect(slugs).toContain(literalSlug);
      expect(slugs).not.toContain(wildcardOnlySlug);
      for (const item of json.data) {
        expect(item.slug).toContain("_underscore_");
      }
    });

    it("search for a trailing backslash matches it literally", async () => {
      // An unescaped `\` would escape the closing `%` and the query would match nothing.
      const unique = uniq("bs");
      const link = await createTestLink({ userId, title: `${unique}back\\slash` });

      const res = await api("GET", `/api/links?q=${encodeURIComponent(`${unique}back\\`)}`, { headers });
      expect(await listIds(res)).toEqual([link.id]);
    });

    it("search matches destinationUrl (not just slug/title)", async () => {
      const unique = uniq("host");
      const link = await createTestLink({ userId, destinationUrl: `https://uniquehost-${unique}.example.com` });

      const res = await api("GET", `/api/links?q=uniquehost-${unique}`, { headers });
      expect(await listIds(res)).toEqual([link.id]);
    });
  });

  // -----------------------------------------------------------------------
  // Sort and pagination edge cases
  // -----------------------------------------------------------------------
  describe("GET /api/links – sort and pagination", () => {
    beforeAll(async () => {
      for (const suffix of ["alpha", "beta", "gamma"]) {
        await createTestLink({ userId, title: `Title-${suffix}` });
      }
    });

    it("sorts by slug ascending", async () => {
      const res = await api("GET", "/api/links?sort=slug&dir=asc", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { slug: string }[] };
      const slugs = json.data.map((l) => l.slug);
      const sorted = [...slugs].sort();
      expect(slugs).toEqual(sorted);
    });

    it("sorts by title descending", async () => {
      const res = await api("GET", "/api/links?sort=title&dir=desc", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { title: string | null }[] };
      const titles = json.data.map((l) => l.title ?? "");
      const sorted = [...titles].sort().reverse();
      expect(titles).toEqual(sorted);
    });

    it.each(["invalid", "__proto__", "constructor", "toString"])(
      "falls back to the default createdAt order for the unknown sort column %j",
      async (sort) => {
        const defaultIds = await listIds(await api("GET", "/api/links", { headers }));
        const res = await api("GET", `/api/links?sort=${sort}`, { headers });
        expect(res.status).toBe(200);
        expect(await listIds(res)).toEqual(defaultIds);
      },
    );

    it("accepts a fractional page (offset must stay an integer for SQLite)", async () => {
      const res = await api("GET", "/api/links?page=1.3&limit=2", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { pagination: { page: number } };
      expect(json.pagination.page).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-user access
  // -----------------------------------------------------------------------
  describe("cross-user access returns 404", () => {
    let otherLinkId: string;

    beforeAll(async () => {
      const other = await newUser("links-crossuser");
      otherLinkId = (await createTestLink({ userId: other.user.id, destinationUrl: "https://example.com/theirs" })).id;
    });

    it.each<[string, string, unknown]>([
      ["GET", "", undefined],
      ["PUT", "", { destinationUrl: "https://hijacked.example.com" }],
      ["DELETE", "", undefined],
      ["PUT", "/targets", { targets: [{ type: "geo", matchValue: "US", destinationUrl: "https://example.com/us" }] }],
    ])("%s another user's link%s leaves it untouched", async (method, suffix, body) => {
      const res = await api(method, `/api/links/${otherLinkId}${suffix}`, { headers, body });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Link not found" });

      const row = await env.DB.prepare("SELECT destinationUrl FROM links WHERE id = ?")
        .bind(otherLinkId).first<{ destinationUrl: string }>();
      expect(row!.destinationUrl).toBe("https://example.com/theirs");
      expect(await env.DB.prepare("SELECT id FROM link_targets WHERE linkId = ?").bind(otherLinkId).first()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // KV write-through on mutation
  // -----------------------------------------------------------------------
  describe("KV cache stays in step with D1", () => {
    type Cached = { url: string; hasPassword: boolean; expiresAt: number | null; targets: { matchValue: string; priority: number }[] | null };

    async function readKv(slug: string) {
      return await env.KV.get(slug, { type: "json" }) as Cached | null;
    }

    it("PUT destinationUrl, password and expiresAt writes them through", async () => {
      const link = await createTestLink({ userId });
      const expiresAt = new Date(Date.now() + 86400000).toISOString();

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { destinationUrl: "https://kv-updated.example.com", password: "s3cret", expiresAt },
      });
      expect(res.status).toBe(200);

      const cached = await readKv(link.slug);
      expect(cached).not.toBeNull();
      expect(cached!.url).toBe("https://kv-updated.example.com");
      expect(cached!.hasPassword).toBe(true);
      expect(cached!.expiresAt).toBe(Math.floor(new Date(expiresAt).getTime() / 1000));
    });

    it("PUT targets writes the target list and bumps updatedAt", async () => {
      const link = await createTestLink({ userId });
      // Backdate so the bump is unambiguous at second resolution.
      await env.DB.prepare("UPDATE links SET updatedAt = 1000 WHERE id = ?").bind(link.id).run();

      const res = await api("PUT", `/api/links/${link.id}/targets`, {
        headers,
        body: { targets: [{ type: "geo", matchValue: "GB", destinationUrl: "https://example.com/gb", priority: 5 }] },
      });
      expect(res.status).toBe(200);

      const cached = await readKv(link.slug);
      expect(cached!.targets).toHaveLength(1);
      expect(cached!.targets![0].matchValue).toBe("GB");
      expect(cached!.targets![0].priority).toBe(5);

      const after = await env.DB.prepare("SELECT updatedAt FROM links WHERE id = ?")
        .bind(link.id).first<{ updatedAt: number }>();
      expect(after!.updatedAt).toBeGreaterThan(1000);
    });

    it("PUT targets stores more rules than one insert could bind and returns the stored rows", async () => {
      const link = await createTestLink({ userId });
      // 20 rows of 6 columns exceed D1's 100 bound parameters per statement.
      const codes = Array.from({ length: 20 }, (_, i) => `A${String.fromCharCode(65 + i)}`);

      const res = await api("PUT", `/api/links/${link.id}/targets`, {
        headers,
        body: { targets: codes.map(code => ({ type: "geo", matchValue: code, destinationUrl: `https://example.com/${code}` })) },
      });
      expect(res.status).toBe(200);

      const json = await res.json() as { data: { id: string }[] };
      const rows = await env.DB.prepare("SELECT id FROM link_targets WHERE linkId = ?")
        .bind(link.id).all<{ id: string }>();
      expect(json.data.map(t => t.id).sort()).toEqual(rows.results.map(r => r.id).sort());

      const cached = await readKv(link.slug);
      expect(cached!.targets).toHaveLength(20);
      expect(Object.keys(cached!.targets![0]).sort()).toEqual(["destinationUrl", "matchValue", "priority", "type"]);
    });

    it("PUT targets clamps a non-finite priority to 0", async () => {
      const link = await createTestLink({ userId });

      const res = await api("PUT", `/api/links/${link.id}/targets`, {
        headers,
        body: {
          targets: [
            { type: "geo", matchValue: "US", destinationUrl: "https://example.com/us", priority: Number.POSITIVE_INFINITY },
            { type: "device", matchValue: "mobile", destinationUrl: "https://example.com/m", priority: 1e9 },
          ],
        },
      });
      expect(res.status).toBe(200);

      const rows = await env.DB.prepare("SELECT matchValue, priority FROM link_targets WHERE linkId = ? ORDER BY matchValue")
        .bind(link.id).all<{ matchValue: string; priority: number }>();
      const byValue = Object.fromEntries(rows.results.map(r => [r.matchValue, r.priority]));
      // JSON.stringify turns Infinity into null, which is not a number → 0.
      expect(byValue["US"]).toBe(0);
      expect(byValue["mobile"]).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------
  // A failure late in the write batch rolls back its earlier statements
  // -----------------------------------------------------------------------
  describe("link and campaign writes are one batch", () => {
    /** Run fn while every link_campaigns insert fails, after the batch's link write has run. */
    async function withFailingCampaignInsert(fn: () => Promise<void>) {
      await env.DB.prepare(
        "CREATE TRIGGER test_fail_link_campaigns BEFORE INSERT ON link_campaigns BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
      ).run();
      try {
        await fn();
      } finally {
        await env.DB.prepare("DROP TRIGGER test_fail_link_campaigns").run();
      }
    }

    it("POST leaves no link behind when a campaign insert fails", async () => {
      const campaign = await createCampaign(headers, "Batch Create");
      const slug = uniq("batch-create");

      await withFailingCampaignInsert(async () => {
        const res = await postLink({ slug, destinationUrl: "https://example.com", campaignIds: [campaign] }, headers);
        expect(res.status).toBe(500);
      });

      expect(await env.DB.prepare("SELECT id FROM links WHERE slug = ?").bind(slug).first()).toBeNull();
    });

    it("PUT keeps the old row and associations when a campaign insert fails", async () => {
      const kept = await createCampaign(headers, "Batch Kept");
      const added = await createCampaign(headers, "Batch Added");
      const link = await createTestLink({ userId, destinationUrl: "https://original.example.com" });
      const attach = await api("PUT", `/api/links/${link.id}`, { headers, body: { campaignIds: [kept] } });
      expect(attach.status).toBe(200);

      await withFailingCampaignInsert(async () => {
        const res = await api("PUT", `/api/links/${link.id}`, {
          headers,
          body: { destinationUrl: "https://changed.example.com", campaignIds: [added] },
        });
        expect(res.status).toBe(500);
      });

      const row = await env.DB.prepare("SELECT destinationUrl FROM links WHERE id = ?")
        .bind(link.id).first<{ destinationUrl: string }>();
      expect(row!.destinationUrl).toBe("https://original.example.com");
      expect(await linkCampaignIds(link.id)).toEqual([kept]);
    });
  });

  // -----------------------------------------------------------------------
  // Campaigns on a team link belong to whoever made them
  // -----------------------------------------------------------------------
  describe("campaigns on a shared team link", () => {
    it("replaces only the caller's associations and shows only the caller's campaigns", async () => {
      const memberA = await newUser("camp-member-a");
      const memberB = await newUser("camp-member-b");
      const team = await createTestTeam(memberA.user.id);
      await addTestTeamMember(team.id, memberB.user.id);
      const link = await createTestLink({ userId: memberA.user.id, teamId: team.id });

      const campaignA = await createCampaign(memberA.headers, "A's campaign");
      const campaignB = await createCampaign(memberB.headers, "B's campaign");

      const attachA = await api("PUT", `/api/links/${link.id}`, { headers: memberA.headers, body: { campaignIds: [campaignA] } });
      expect(attachA.status).toBe(200);

      const attachB = await api("PUT", `/api/links/${link.id}`, {
        headers: memberB.headers,
        body: { title: "Shared", campaignIds: [campaignB] },
      });
      expect(attachB.status).toBe(200);
      expect(await linkCampaignIds(link.id)).toEqual([campaignA, campaignB].sort());

      const seenByB = await api("GET", `/api/links/${link.id}`, { headers: memberB.headers });
      const jsonB = await seenByB.json() as { data: { campaigns: { id: string }[] } };
      expect(jsonB.data.campaigns.map(cp => cp.id)).toEqual([campaignB]);

      const seenByA = await api("GET", `/api/links/${link.id}`, { headers: memberA.headers });
      const jsonA = await seenByA.json() as { data: { campaigns: { id: string }[] } };
      expect(jsonA.data.campaigns.map(cp => cp.id)).toEqual([campaignA]);

      // Clearing B's list leaves A's association in place.
      const clearB = await api("PUT", `/api/links/${link.id}`, { headers: memberB.headers, body: { campaignIds: [] } });
      expect(clearB.status).toBe(200);
      expect(await linkCampaignIds(link.id)).toEqual([campaignA]);
    });
  });
});
