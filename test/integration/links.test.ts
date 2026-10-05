import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx, api, postLink, insertClickStat, type JsonBody } from "../helpers";
import { hashPassword } from "../../src/services/password";

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
      // Create link for current user
      await createTestLink({ slug: "my-link-iso", userId });

      // Create link for another user
      const otherAuth = await setupAuth({ email: "other-list@test.com" });
      await createTestLink({ slug: "other-link-iso", userId: otherAuth.user.id });

      const res = await api("GET", "/api/links", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      const slugs = json.data.map((l) => l.slug);
      expect(slugs).toContain("my-link-iso");
      expect(slugs).not.toContain("other-link-iso");
    });

    it("paginates correctly", async () => {
      for (let i = 0; i < 3; i++) {
        await createTestLink({ slug: `page-${crypto.randomUUID().slice(0, 8)}`, userId });
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
      await createTestLink({ slug: "titled-link", userId, title: "UniqueTitle42" });
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

    it("rejects missing slug with 400", async () => {
      const res = await postLink({ destinationUrl: "https://example.com" }, headers);
      expect(res.status).toBe(400);
    });

    it("rejects missing destinationUrl with 400", async () => {
      const res = await postLink({ slug: "no-dest" }, headers);
      expect(res.status).toBe(400);
    });

    it("rejects non-http(s) URL with 400", async () => {
      const res = await postLink(
        { slug: "ftp-link", destinationUrl: "ftp://files.example.com/data" },
        headers
      );
      expect(res.status).toBe(400);
    });

    it("rejects reserved slugs with 400", async () => {
      const res = await postLink(
        { slug: "api", destinationUrl: "https://example.com" },
        headers
      );
      expect(res.status).toBe(400);
    });

    it("rejects duplicate slug with 409", async () => {
      await createTestLink({ slug: "taken-slug", userId });
      const res = await postLink(
        { slug: "taken-slug", destinationUrl: "https://example.com" },
        headers
      );
      expect(res.status).toBe(409);
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

    it.each(["has space", "has/slash", "has?query", "has#hash", "has%percent", "has<angle"])(
      "rejects the URL-unsafe slug %j with 400",
      async (slug) => {
        const res = await postLink({ slug, destinationUrl: "https://example.com" }, headers);
        expect(res.status).toBe(400);
      },
    );
  });

  // -----------------------------------------------------------------------
  // GET BY ID  GET /api/links/:id
  // -----------------------------------------------------------------------
  describe("GET /api/links/:id", () => {
    it("returns a link with totalClicks=0 when no stats exist", async () => {
      const link = await createTestLink({ slug: "get-zero", userId });
      const res = await api("GET", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; totalClicks: number } };
      expect(json.data.id).toBe(link.id);
      expect(json.data.totalClicks).toBe(0);
    });

    it("returns aggregated totalClicks from link_stats", async () => {
      const link = await createTestLink({ slug: "get-clicks", userId });
      await insertClickStat(link.id, 15, "2026-03-15");
      await insertClickStat(link.id, 25, "2026-03-16");

      const res = await api("GET", `/api/links/${link.id}`, { headers });
      const json = await res.json() as { data: { totalClicks: number } };
      expect(json.data.totalClicks).toBe(40);
    });

    it("returns 404 for non-existent ID", async () => {
      const res = await api("GET", "/api/links/nonexistent-id", { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for link owned by a different user", async () => {
      const otherAuth = await setupAuth({ email: "iso2@test.com" });
      const link = await createTestLink({ slug: "other-owned", userId: otherAuth.user.id });

      const res = await api("GET", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // UPDATE  PUT /api/links/:id
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id", () => {
    it("updates the destination URL", async () => {
      const link = await createTestLink({ slug: "update-dest", userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { destinationUrl: "https://new-destination.com" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { destinationUrl: string } };
      expect(json.data.destinationUrl).toBe("https://new-destination.com");
    });

    it("updates the title and ignores a slug in the body, even a taken one", async () => {
      await createTestLink({ slug: "conflict-target2", userId });
      const link = await createTestLink({ slug: "immutable-slug", userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { slug: "conflict-target2", title: "Updated" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { slug: string; title: string } };
      expect(json.data.slug).toBe("immutable-slug");
      expect(json.data.title).toBe("Updated");
    });

    it("returns 404 for non-existent link", async () => {
      const res = await api("PUT", "/api/links/nonexistent-id", {
        headers,
        body: { title: "Nope" },
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // TOGGLE ACTIVE  PATCH /api/links/:id/active
  // -----------------------------------------------------------------------
  describe("PATCH /api/links/:id/active", () => {
    it("deactivates a link and invalidates its cached redirect", async () => {
      const link = await createTestLink({ slug: "deactivate-me", userId, isActive: true });

      // Seed the KV cache the way the redirect path would. Key format matches
      // kvKey() in src/services/kv-cache.ts: bare slug when there is no custom domain.
      await env.KV.put(
        "deactivate-me",
        JSON.stringify({ url: link.destinationUrl, redirectType: 302, linkId: link.id, isActive: true }),
      );
      // Sanity: the entry exists before we deactivate, so a null afterwards can only
      // mean deactivation deleted it (not that it was never there).
      expect(await env.KV.get("deactivate-me")).not.toBeNull();

      const res = await api("PATCH", `/api/links/${link.id}/active`, {
        headers,
        body: { isActive: false },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; isActive: boolean };
      expect(json.success).toBe(true);
      expect(json.isActive).toBe(false);

      const kv = await env.KV.get("deactivate-me");
      expect(kv).toBeNull();
    });

    it("reactivates a link and repopulates its cached redirect", async () => {
      const slug = `kv-reactivate-${crypto.randomUUID().slice(0, 8)}`;
      const link = await createTestLink({ slug, userId, isActive: false });
      expect(await env.KV.get(slug)).toBeNull();

      const res = await api("PATCH", `/api/links/${link.id}/active`, {
        headers,
        body: { isActive: true },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; isActive: boolean };
      expect(json.isActive).toBe(true);

      const cached = await env.KV.get(slug, { type: "json" }) as { url: string; isActive: boolean } | null;
      expect(cached).not.toBeNull();
      expect(cached!.isActive).toBe(true);
      expect(cached!.url).toBe(link.destinationUrl);
    });

    it("returns 404 for non-existent link", async () => {
      const res = await api("PATCH", "/api/links/nonexistent-id/active", {
        headers,
        body: { isActive: false },
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE  DELETE /api/links/:id
  // -----------------------------------------------------------------------
  describe("DELETE /api/links/:id", () => {
    it("returns success, clears the cache entry and 404s on re-fetch", async () => {
      const slug = `kv-delete-${crypto.randomUUID().slice(0, 8)}`;
      const link = await createTestLink({ slug, userId });
      await env.KV.put(slug, JSON.stringify({ url: link.destinationUrl, linkId: link.id, isActive: true }));

      const res = await api("DELETE", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(await env.KV.get(slug)).toBeNull();

      const refetch = await api("GET", `/api/links/${link.id}`, { headers });
      expect(refetch.status).toBe(404);
    });

    it("returns 404 for non-existent link", async () => {
      const res = await api("DELETE", "/api/links/nonexistent-id", { headers });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // NO BODY tests
  // -----------------------------------------------------------------------
  describe("No body requests", () => {
    it("POST /api/links with no body returns 400", async () => {
      const res = await app.request("/api/links", {
        method: "POST",
        headers: { Cookie: headers.Cookie },
      }, env);
      expect(res.status).toBe(400);
    });

    it("PUT /api/links/:id with no body returns 400", async () => {
      const link = await createTestLink({ slug: `no-body-put-${crypto.randomUUID().slice(0, 8)}`, userId });
      const res = await app.request(`/api/links/${link.id}`, {
        method: "PUT",
        headers: { Cookie: headers.Cookie },
      }, env);
      expect(res.status).toBe(400);
    });

    it("PUT /api/links/:id/targets with no body returns 400", async () => {
      const link = await createTestLink({ slug: `no-body-targets-${crypto.randomUUID().slice(0, 8)}`, userId });
      const res = await app.request(`/api/links/${link.id}/targets`, {
        method: "PUT",
        headers: { Cookie: headers.Cookie },
      }, env);
      expect(res.status).toBe(400);
    });

    it("PATCH /api/links/:id/active with no body toggles (does not crash)", async () => {
      const link = await createTestLink({ slug: `no-body-toggle-${crypto.randomUUID().slice(0, 8)}`, userId, isActive: true });
      const res = await app.request(`/api/links/${link.id}/active`, {
        method: "PATCH",
        headers: { Cookie: headers.Cookie },
      }, env);
      expect(res.status).toBe(200);
      const json = await res.json() as { isActive: boolean };
      expect(json.isActive).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Link create with advanced fields
  // -----------------------------------------------------------------------
  describe("POST /api/links – advanced fields", () => {
    it("creates link with OG fields", async () => {
      const res = await postLink({
        slug: `og-link-${crypto.randomUUID().slice(0, 8)}`,
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

    it("rejects invalid ogImage URL (ftp://)", async () => {
      const res = await postLink({
        slug: `og-ftp-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        ogImage: "ftp://files.example.com/image.png",
      }, headers);
      expect(res.status).toBe(400);
    });

    it("rejects expiresAt in the past", async () => {
      const res = await postLink({
        slug: `exp-past-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        expiresAt: "2020-01-01T00:00:00Z",
      }, headers);
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toContain("expiresAt must be in the future");
    });

    it("rejects invalid expiresAt string", async () => {
      const res = await postLink({
        slug: `exp-invalid-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        expiresAt: "not-a-date",
      }, headers);
      expect(res.status).toBe(400);
    });

    it.each([0, -1])("rejects maxClicks %i", async (maxClicks) => {
      const res = await postLink({
        slug: `mc-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        maxClicks,
      }, headers);
      expect(res.status).toBe(400);
    });

    it("creates link with password (hasPassword: true, no hash in response)", async () => {
      const res = await postLink({
        slug: `pw-create-${crypto.randomUUID().slice(0, 8)}`,
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
        slug: `internal-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        isInternal: true,
      }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { isInternal: boolean } };
      expect(json.data.isInternal).toBe(true);
    });

    it("creates link with paramForwarding: true", async () => {
      const res = await postLink({
        slug: `paramfwd-${crypto.randomUUID().slice(0, 8)}`,
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
      const link = await createTestLink({
        slug: `clear-exp-${crypto.randomUUID().slice(0, 8)}`,
        userId,
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { expiresAt: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { expiresAt: unknown } };
      expect(json.data.expiresAt).toBeNull();
    });

    it("clears maxClicks with null", async () => {
      const link = await createTestLink({ slug: `clear-mc-${crypto.randomUUID().slice(0, 8)}`, userId, maxClicks: 100 });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { maxClicks: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { maxClicks: unknown } };
      expect(json.data.maxClicks).toBeNull();
    });

    it("clears password with empty string", async () => {
      const link = await createTestLink({
        slug: `clear-pw-${crypto.randomUUID().slice(0, 8)}`,
        userId,
        password: await hashPassword("secret"),
      });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { password: "" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hasPassword: boolean } };
      expect(json.data.hasPassword).toBe(false);
    });

    it("clears ogImage with null", async () => {
      const link = await createTestLink({
        slug: `clear-og-${crypto.randomUUID().slice(0, 8)}`,
        userId,
        ogImage: "https://example.com/img.png",
      });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { ogImage: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { ogImage: unknown } };
      expect(json.data.ogImage).toBeNull();
    });

    it("toggles isInternal and paramForwarding", async () => {
      const link = await createTestLink({ slug: `toggle-flags-${crypto.randomUUID().slice(0, 8)}`, userId });

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
      const link = await createTestLink({ slug: `redir-change-${crypto.randomUUID().slice(0, 8)}`, userId });
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
      const link = await createTestLink({ slug: `target-val-${crypto.randomUUID().slice(0, 8)}`, userId });
      targetLinkId = link.id;
    });

    it.each([
      ["targets not an array", "not-array"],
      ["an unknown type", [{ type: "browser", matchValue: "chrome", destinationUrl: "https://example.com" }]],
      ["an empty matchValue", [{ type: "geo", matchValue: "", destinationUrl: "https://example.com" }]],
      ["a geo matchValue that is not 2 letters", [{ type: "geo", matchValue: "USA", destinationUrl: "https://example.com" }]],
      ["a device matchValue outside mobile/tablet/desktop", [{ type: "device", matchValue: "phone", destinationUrl: "https://example.com" }]],
      ["a non-http(s) destinationUrl", [{ type: "geo", matchValue: "US", destinationUrl: "ftp://bad.com" }]],
    ])("rejects %s", async (_label, targets) => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, { headers, body: { targets } });
      expect(res.status).toBe(400);
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
      const unique = crypto.randomUUID().slice(0, 8);
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
      const unique = crypto.randomUUID().slice(0, 8);
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
      const unique = crypto.randomUUID().slice(0, 8);
      const slug = `backslash-${unique}`;
      await createTestLink({ slug, userId, title: `${unique}back\\slash` });

      const res = await api("GET", `/api/links?q=${encodeURIComponent(`${unique}back\\`)}`, { headers });
      const json = await res.json() as { data: { slug: string }[] };
      expect(json.data.map((l) => l.slug)).toEqual([slug]);
    });

    it("search matches destinationUrl (not just slug/title)", async () => {
      const unique = crypto.randomUUID().slice(0, 8);
      await createTestLink({ slug: `url-search-${unique}`, userId, destinationUrl: `https://uniquehost-${unique}.example.com` });

      const res = await api("GET", `/api/links?q=uniquehost-${unique}`, { headers });
      const json = await res.json() as { data: { slug: string }[] };
      expect(json.data.some((l) => l.slug === `url-search-${unique}`)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Sort and pagination edge cases
  // -----------------------------------------------------------------------
  describe("GET /api/links – sort and pagination", () => {
    beforeAll(async () => {
      // Create a few links with different slugs and titles
      for (const suffix of ["alpha", "beta", "gamma"]) {
        await createTestLink({
          slug: `sort-${suffix}-${crypto.randomUUID().slice(0, 8)}`,
          userId,
          title: `Title-${suffix}`,
        });
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

    it("falls back to createdAt for invalid sort column", async () => {
      const res = await api("GET", "/api/links?sort=invalid", { headers });
      expect(res.status).toBe(200);
      // Should not error — just default to createdAt desc
      const json = await res.json() as { data: unknown[] };
      expect(Array.isArray(json.data)).toBe(true);
    });

    it("accepts a fractional page (offset must stay an integer for SQLite)", async () => {
      const res = await api("GET", "/api/links?page=1.3&limit=2", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { pagination: { page: number } };
      expect(json.pagination.page).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-user ownership on mutating routes
  // -----------------------------------------------------------------------
  describe("cross-user access returns 404", () => {
    let otherLinkId: string;

    beforeAll(async () => {
      const otherAuth = await setupAuth({ email: "links-crossuser@test.com" });
      const link = await createTestLink({
        slug: `cross-user-${crypto.randomUUID().slice(0, 8)}`,
        userId: otherAuth.user.id,
      });
      otherLinkId = link.id;
    });

    it("PUT another user's link", async () => {
      const res = await api("PUT", `/api/links/${otherLinkId}`, {
        headers,
        body: { destinationUrl: "https://hijacked.example.com" },
      });
      expect(res.status).toBe(404);
    });

    it("PATCH another user's link active state", async () => {
      const res = await api("PATCH", `/api/links/${otherLinkId}/active`, {
        headers,
        body: { isActive: false },
      });
      expect(res.status).toBe(404);
    });

    it("DELETE another user's link", async () => {
      const res = await api("DELETE", `/api/links/${otherLinkId}`, { headers });
      expect(res.status).toBe(404);

      const row = await env.DB.prepare("SELECT id FROM links WHERE id = ?").bind(otherLinkId).first();
      expect(row).not.toBeNull();
    });

    it("PUT another user's link targets", async () => {
      const res = await api("PUT", `/api/links/${otherLinkId}/targets`, {
        headers,
        body: { targets: [{ type: "geo", matchValue: "US", destinationUrl: "https://example.com/us" }] },
      });
      expect(res.status).toBe(404);

      const row = await env.DB.prepare("SELECT id FROM link_targets WHERE linkId = ?").bind(otherLinkId).first();
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // KV write-through on mutation
  // -----------------------------------------------------------------------
  describe("KV cache stays in step with D1", () => {
    type Cached = { url: string; hasPassword: boolean; expiresAt: number | null; isActive: boolean; targets: { matchValue: string; priority: number }[] | null };

    async function readKv(slug: string) {
      return await env.KV.get(slug, { type: "json" }) as Cached | null;
    }

    it("PUT destinationUrl, password and expiresAt writes them through", async () => {
      const slug = `kv-put-${crypto.randomUUID().slice(0, 8)}`;
      const link = await createTestLink({ slug, userId });
      const expiresAt = new Date(Date.now() + 86400000).toISOString();

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { destinationUrl: "https://kv-updated.example.com", password: "s3cret", expiresAt },
      });
      expect(res.status).toBe(200);

      const cached = await readKv(slug);
      expect(cached).not.toBeNull();
      expect(cached!.url).toBe("https://kv-updated.example.com");
      expect(cached!.hasPassword).toBe(true);
      expect(cached!.expiresAt).toBe(Math.floor(new Date(expiresAt).getTime() / 1000));
    });

    it("PUT targets writes the target list and bumps updatedAt", async () => {
      const slug = `kv-targets-${crypto.randomUUID().slice(0, 8)}`;
      const link = await createTestLink({ slug, userId });
      // Backdate so the bump is unambiguous at second resolution.
      await env.DB.prepare("UPDATE links SET updatedAt = 1000 WHERE id = ?").bind(link.id).run();

      const res = await api("PUT", `/api/links/${link.id}/targets`, {
        headers,
        body: { targets: [{ type: "geo", matchValue: "GB", destinationUrl: "https://example.com/gb", priority: 5 }] },
      });
      expect(res.status).toBe(200);

      const cached = await readKv(slug);
      expect(cached!.targets).toHaveLength(1);
      expect(cached!.targets![0].matchValue).toBe("GB");
      expect(cached!.targets![0].priority).toBe(5);

      const after = await env.DB.prepare("SELECT updatedAt FROM links WHERE id = ?")
        .bind(link.id).first<{ updatedAt: number }>();
      expect(after!.updatedAt).toBeGreaterThan(1000);
    });

    it("PUT targets stores more rules than one insert could bind and returns the stored rows", async () => {
      const slug = `kv-many-targets-${crypto.randomUUID().slice(0, 8)}`;
      const link = await createTestLink({ slug, userId });
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

      const cached = await readKv(slug);
      expect(cached!.targets).toHaveLength(20);
      expect(Object.keys(cached!.targets![0]).sort()).toEqual(["destinationUrl", "matchValue", "priority", "type"]);
    });

    it("PUT targets clamps a non-finite priority to 0", async () => {
      const slug = `kv-priority-${crypto.randomUUID().slice(0, 8)}`;
      const link = await createTestLink({ slug, userId });

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
  // Validation before any write
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id – validation order and body types", () => {
    it("a bogus campaignId leaves D1 and KV untouched", async () => {
      const slug = `put-bad-campaign-${crypto.randomUUID().slice(0, 8)}`;
      const link = await createTestLink({ slug, userId, destinationUrl: "https://original.example.com" });
      await env.KV.put(slug, JSON.stringify({ url: "https://original.example.com", linkId: link.id, isActive: true }));

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { destinationUrl: "https://changed.example.com", campaignIds: ["no-such-campaign"] },
      });
      expect(res.status).toBe(400);

      const row = await env.DB.prepare("SELECT destinationUrl FROM links WHERE id = ?")
        .bind(link.id).first<{ destinationUrl: string }>();
      expect(row!.destinationUrl).toBe("https://original.example.com");

      const cached = await env.KV.get(slug, { type: "json" }) as { url: string };
      expect(cached.url).toBe("https://original.example.com");
    });

    it("rejects a non-array campaignIds with 400", async () => {
      const link = await createTestLink({ slug: `put-campaignids-type-${crypto.randomUUID().slice(0, 8)}`, userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { campaignIds: "not-an-array" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects a non-string password with 400", async () => {
      const link = await createTestLink({ slug: `put-password-type-${crypto.randomUUID().slice(0, 8)}`, userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { password: { hash: "x" } },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/links – body types", () => {
    it("rejects a non-string password with 400", async () => {
      const res = await postLink({
        slug: `post-password-type-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        password: 12345,
      }, headers);
      expect(res.status).toBe(400);
    });

    it("rejects a non-array campaignIds with 400", async () => {
      const res = await postLink({
        slug: `post-campaignids-type-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        campaignIds: "nope",
      }, headers);
      expect(res.status).toBe(400);
    });

    it("rejects an unknown campaignId with 400 and creates nothing", async () => {
      const slug = `post-unknown-campaign-${crypto.randomUUID().slice(0, 8)}`;
      const res = await postLink({
        slug,
        destinationUrl: "https://example.com",
        campaignIds: ["no-such-campaign"],
      }, headers);
      expect(res.status).toBe(400);

      const row = await env.DB.prepare("SELECT id FROM links WHERE slug = ?").bind(slug).first();
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // PATCH /:id/active body handling
  // -----------------------------------------------------------------------
  describe("PATCH /api/links/:id/active – body handling", () => {
    it("an empty object toggles instead of deactivating", async () => {
      const link = await createTestLink({ slug: `toggle-empty-${crypto.randomUUID().slice(0, 8)}`, userId, isActive: false });
      const res = await api("PATCH", `/api/links/${link.id}/active`, { headers, body: {} });
      expect(res.status).toBe(200);
      const json = await res.json() as { isActive: boolean };
      expect(json.isActive).toBe(true);
    });

    it("an oversized body returns 413, not a toggle", async () => {
      const link = await createTestLink({ slug: `toggle-big-${crypto.randomUUID().slice(0, 8)}`, userId, isActive: true });
      const body = JSON.stringify({ isActive: false, pad: "x".repeat(11_000) });
      const res = await app.request(`/api/links/${link.id}/active`, {
        method: "PATCH",
        headers: { ...headers, "Content-Length": String(new TextEncoder().encode(body).byteLength) },
        body,
      }, env, mockExecutionCtx());
      expect(res.status).toBe(413);

      const row = await env.DB.prepare("SELECT isActive FROM links WHERE id = ?")
        .bind(link.id).first<{ isActive: number }>();
      expect(row!.isActive).toBe(1);
    });
  });
});
