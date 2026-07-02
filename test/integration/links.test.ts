import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx, apiRequest, insertClickStat, type JsonBody } from "../helpers";
import { hashPassword } from "../../src/services/password";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(method: string, path: string, opts: { headers?: Record<string, string>; body?: JsonBody } = {}) {
  return apiRequest(app, method, path, opts);
}

/** Shorthand: POST /api/links with auth. */
function postLink(body: JsonBody, headers: Record<string, string>) {
  return api("POST", "/api/links", { headers, body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Links API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth(env);
    headers = auth.headers;
    userId = auth.user.id;
  });

  // -----------------------------------------------------------------------
  // LIST  GET /api/links
  // -----------------------------------------------------------------------
  describe("GET /api/links", () => {
    it("returns empty list with pagination", async () => {
      const res = await api("GET", "/api/links", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[]; pagination: { page: number; limit: number; total: number } };
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.pagination).toMatchObject({ page: 1, limit: 20 });
    });

    it("lists only the authenticated user's links", async () => {
      // Create link for current user
      await createTestLink(env.DB, { slug: "my-link-iso", userId });

      // Create link for another user
      const otherAuth = await setupAuth(env, { email: "other-list@test.com" });
      await createTestLink(env.DB, { slug: "other-link-iso", userId: otherAuth.user.id });

      const res = await api("GET", "/api/links", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      const slugs = json.data.map((l) => l.slug);
      expect(slugs).toContain("my-link-iso");
      expect(slugs).not.toContain("other-link-iso");
    });

    it("paginates correctly", async () => {
      for (let i = 0; i < 3; i++) {
        await createTestLink(env.DB, { slug: `page-${crypto.randomUUID().slice(0, 8)}`, userId });
      }

      const res = await api("GET", "/api/links?page=1&limit=2", { headers });
      const json = await res.json() as { data: unknown[]; pagination: { page: number; limit: number; total: number } };
      expect(json.data).toHaveLength(2);
      expect(json.pagination.page).toBe(1);
      expect(json.pagination.limit).toBe(2);
    });

    it("searches by slug substring", async () => {
      await createTestLink(env.DB, { slug: "findme-slug", userId });
      const res = await api("GET", "/api/links?q=findme", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      expect(json.data.some((l) => l.slug === "findme-slug")).toBe(true);
    });

    it("searches by title substring", async () => {
      await createTestLink(env.DB, { slug: "titled-link", userId, title: "UniqueTitle42" });
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

    it("rejects invalid slug (spaces) with 400", async () => {
      const res = await postLink(
        { slug: "has space", destinationUrl: "https://example.com" },
        headers
      );
      expect(res.status).toBe(400);
    });

    it("rejects duplicate slug with 409", async () => {
      await createTestLink(env.DB, { slug: "taken-slug", userId });
      const res = await postLink(
        { slug: "taken-slug", destinationUrl: "https://example.com" },
        headers
      );
      expect(res.status).toBe(409);
    });

    it("rejects oversized body with 413", async () => {
      const bigTitle = "x".repeat(11_000);
      const body = JSON.stringify({ slug: "big", destinationUrl: "https://example.com", title: bigTitle });
      const res = await app.request("/api/links", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": String(new TextEncoder().encode(body).byteLength),
        },
        body,
      }, env);
      expect(res.status).toBe(413);
    });

    it("rejects unauthenticated request with 401", async () => {
      const res = await api("POST", "/api/links", {
        headers: { "Content-Type": "application/json" },
        body: { slug: "noauth", destinationUrl: "https://example.com" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // GET BY ID  GET /api/links/:id
  // -----------------------------------------------------------------------
  describe("GET /api/links/:id", () => {
    it("returns a link with totalClicks=0 when no stats exist", async () => {
      const link = await createTestLink(env.DB, { slug: "get-zero", userId });
      const res = await api("GET", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; totalClicks: number } };
      expect(json.data.id).toBe(link.id);
      expect(json.data.totalClicks).toBe(0);
    });

    it("returns aggregated totalClicks from link_stats", async () => {
      const link = await createTestLink(env.DB, { slug: "get-clicks", userId });
      await insertClickStat(env.DB, link.id, 15, "2026-03-15");
      await insertClickStat(env.DB, link.id, 25, "2026-03-16");

      const res = await api("GET", `/api/links/${link.id}`, { headers });
      const json = await res.json() as { data: { totalClicks: number } };
      expect(json.data.totalClicks).toBe(40);
    });

    it("returns 404 for non-existent ID", async () => {
      const res = await api("GET", "/api/links/nonexistent-id", { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for link owned by a different user", async () => {
      const otherAuth = await setupAuth(env, { email: "iso2@test.com" });
      const link = await createTestLink(env.DB, { slug: "other-owned", userId: otherAuth.user.id });

      const res = await api("GET", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // UPDATE  PUT /api/links/:id
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id", () => {
    it("updates the destination URL", async () => {
      const link = await createTestLink(env.DB, { slug: "update-dest", userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { destinationUrl: "https://new-destination.com" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { destinationUrl: string } };
      expect(json.data.destinationUrl).toBe("https://new-destination.com");
    });

    it("ignores slug in PUT body (slug is immutable)", async () => {
      const link = await createTestLink(env.DB, { slug: "immutable-slug", userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { slug: "new-slug", title: "Updated" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { slug: string; title: string } };
      expect(json.data.slug).toBe("immutable-slug");
      expect(json.data.title).toBe("Updated");
    });

    it("updates the title", async () => {
      const link = await createTestLink(env.DB, { slug: "update-title", userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { title: "New Title" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { title: string } };
      expect(json.data.title).toBe("New Title");
    });

    it("returns 404 for non-existent link", async () => {
      const res = await api("PUT", "/api/links/nonexistent-id", {
        headers,
        body: { title: "Nope" },
      });
      expect(res.status).toBe(404);
    });

    it("PUT does not allow slug changes so no slug conflict is possible", async () => {
      await createTestLink(env.DB, { slug: "conflict-target2", userId });
      const link = await createTestLink(env.DB, { slug: "conflict-source2", userId });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { slug: "conflict-target2", title: "test" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { slug: string } };
      expect(json.data.slug).toBe("conflict-source2");
    });
  });

  // -----------------------------------------------------------------------
  // TOGGLE ACTIVE  PATCH /api/links/:id/active
  // -----------------------------------------------------------------------
  describe("PATCH /api/links/:id/active", () => {
    it("deactivates a link and invalidates its cached redirect", async () => {
      const link = await createTestLink(env.DB, { slug: "deactivate-me", userId, isActive: true });

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

    it("reactivates a link", async () => {
      const link = await createTestLink(env.DB, { slug: "reactivate-me", userId, isActive: false });
      const res = await api("PATCH", `/api/links/${link.id}/active`, {
        headers,
        body: { isActive: true },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; isActive: boolean };
      expect(json.isActive).toBe(true);
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
    it("deletes a link successfully", async () => {
      const link = await createTestLink(env.DB, { slug: "delete-me", userId });
      const res = await api("DELETE", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(true);
    });

    it("returns 404 when re-fetching a deleted link", async () => {
      const link = await createTestLink(env.DB, { slug: "delete-then-get", userId });
      await api("DELETE", `/api/links/${link.id}`, { headers });

      const res = await api("GET", `/api/links/${link.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent link", async () => {
      const res = await api("DELETE", "/api/links/nonexistent-id", { headers });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // NO BODY tests (Task 1)
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
      const link = await createTestLink(env.DB, { slug: `no-body-put-${crypto.randomUUID().slice(0, 8)}`, userId });
      const res = await app.request(`/api/links/${link.id}`, {
        method: "PUT",
        headers: { Cookie: headers.Cookie },
      }, env);
      expect(res.status).toBe(400);
    });

    it("PUT /api/links/:id/targets with no body returns 400", async () => {
      const link = await createTestLink(env.DB, { slug: `no-body-targets-${crypto.randomUUID().slice(0, 8)}`, userId });
      const res = await app.request(`/api/links/${link.id}/targets`, {
        method: "PUT",
        headers: { Cookie: headers.Cookie },
      }, env);
      expect(res.status).toBe(400);
    });

    it("PATCH /api/links/:id/active with no body toggles (does not crash)", async () => {
      const link = await createTestLink(env.DB, { slug: `no-body-toggle-${crypto.randomUUID().slice(0, 8)}`, userId, isActive: true });
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
  // checkPassword (Task 3)
  // -----------------------------------------------------------------------
  describe("POST /api/links/:id/check-password", () => {
    it("returns success for correct password", async () => {
      const hashed = await hashPassword("secret123");
      const link = await createTestLink(env.DB, { slug: `pw-correct-${crypto.randomUUID().slice(0, 8)}`, userId });
      await env.DB.prepare("UPDATE links SET password = ? WHERE id = ?").bind(hashed, link.id).run();

      const res = await app.request(`/api/links/${link.id}/check-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret123" }),
      }, env, mockExecutionCtx());
      expect(res.status).toBe(200);
      const json = await res.json() as { valid: boolean };
      expect(json.valid).toBe(true);
    });

    it("returns valid:false for wrong password", async () => {
      const hashed = await hashPassword("secret123");
      const link = await createTestLink(env.DB, { slug: `pw-wrong-${crypto.randomUUID().slice(0, 8)}`, userId });
      await env.DB.prepare("UPDATE links SET password = ? WHERE id = ?").bind(hashed, link.id).run();

      const res = await app.request(`/api/links/${link.id}/check-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrongpass" }),
      }, env, mockExecutionCtx());
      expect(res.status).toBe(200);
      const json = await res.json() as { valid: boolean };
      expect(json.valid).toBe(false);
    });

    it("returns 404 for link with no password", async () => {
      const link = await createTestLink(env.DB, { slug: `pw-none-${crypto.randomUUID().slice(0, 8)}`, userId });
      const res = await app.request(`/api/links/${link.id}/check-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "anything" }),
      }, env, mockExecutionCtx());
      expect(res.status).toBe(404);
    });

    it("returns 400 for no body", async () => {
      const hashed = await hashPassword("secret123");
      const link = await createTestLink(env.DB, { slug: `pw-nobody-${crypto.randomUUID().slice(0, 8)}`, userId });
      await env.DB.prepare("UPDATE links SET password = ? WHERE id = ?").bind(hashed, link.id).run();

      const res = await app.request(`/api/links/${link.id}/check-password`, {
        method: "POST",
      }, env, mockExecutionCtx());
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing password field", async () => {
      const hashed = await hashPassword("secret123");
      const link = await createTestLink(env.DB, { slug: `pw-nofield-${crypto.randomUUID().slice(0, 8)}`, userId });
      await env.DB.prepare("UPDATE links SET password = ? WHERE id = ?").bind(hashed, link.id).run();

      const res = await app.request(`/api/links/${link.id}/check-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notPassword: "test" }),
      }, env, mockExecutionCtx());
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Link create with advanced fields (Task 13)
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

    it("rejects maxClicks: 0", async () => {
      const res = await postLink({
        slug: `mc-zero-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        maxClicks: 0,
      }, headers);
      expect(res.status).toBe(400);
    });

    it("rejects maxClicks: -1", async () => {
      const res = await postLink({
        slug: `mc-neg-${crypto.randomUUID().slice(0, 8)}`,
        destinationUrl: "https://example.com",
        maxClicks: -1,
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
  // Link update clearing fields (Task 14)
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id – clearing fields", () => {
    it("clears expiresAt with null", async () => {
      const link = await createTestLink(env.DB, { slug: `clear-exp-${crypto.randomUUID().slice(0, 8)}`, userId });
      // Set expiresAt first
      await env.DB.prepare("UPDATE links SET expiresAt = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) + 86400, link.id).run();

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { expiresAt: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { expiresAt: unknown } };
      expect(json.data.expiresAt).toBeNull();
    });

    it("clears maxClicks with null", async () => {
      const link = await createTestLink(env.DB, { slug: `clear-mc-${crypto.randomUUID().slice(0, 8)}`, userId });
      await env.DB.prepare("UPDATE links SET maxClicks = ? WHERE id = ?").bind(100, link.id).run();

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { maxClicks: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { maxClicks: unknown } };
      expect(json.data.maxClicks).toBeNull();
    });

    it("clears password with empty string", async () => {
      const link = await createTestLink(env.DB, { slug: `clear-pw-${crypto.randomUUID().slice(0, 8)}`, userId });
      const hashed = await hashPassword("secret");
      await env.DB.prepare("UPDATE links SET password = ? WHERE id = ?").bind(hashed, link.id).run();

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { password: "" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hasPassword: boolean } };
      expect(json.data.hasPassword).toBe(false);
    });

    it("clears ogImage with null", async () => {
      const link = await createTestLink(env.DB, { slug: `clear-og-${crypto.randomUUID().slice(0, 8)}`, userId });
      await env.DB.prepare("UPDATE links SET ogImage = ? WHERE id = ?").bind("https://example.com/img.png", link.id).run();

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { ogImage: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { ogImage: unknown } };
      expect(json.data.ogImage).toBeNull();
    });

    it("toggles isInternal and paramForwarding", async () => {
      const link = await createTestLink(env.DB, { slug: `toggle-flags-${crypto.randomUUID().slice(0, 8)}`, userId });

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
      const link = await createTestLink(env.DB, { slug: `redir-change-${crypto.randomUUID().slice(0, 8)}`, userId });
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
  // Target validation errors (Task 15)
  // -----------------------------------------------------------------------
  describe("PUT /api/links/:id/targets – validation", () => {
    let targetLinkId: string;

    beforeAll(async () => {
      const link = await createTestLink(env.DB, { slug: `target-val-${crypto.randomUUID().slice(0, 8)}`, userId });
      targetLinkId = link.id;
    });

    it("rejects targets not an array", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: "not-array" } as unknown as JsonBody,
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid type (not geo/device)", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [{ type: "browser", matchValue: "chrome", destinationUrl: "https://example.com" }] } as unknown as JsonBody,
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty matchValue", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [{ type: "geo", matchValue: "", destinationUrl: "https://example.com" }] } as unknown as JsonBody,
      });
      expect(res.status).toBe(400);
    });

    it("rejects geo matchValue 'USA' (not 2-letter)", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [{ type: "geo", matchValue: "USA", destinationUrl: "https://example.com" }] } as unknown as JsonBody,
      });
      expect(res.status).toBe(400);
    });

    it("rejects device matchValue 'phone' (not mobile/tablet/desktop)", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [{ type: "device", matchValue: "phone", destinationUrl: "https://example.com" }] } as unknown as JsonBody,
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid destinationUrl in target", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [{ type: "geo", matchValue: "US", destinationUrl: "ftp://bad.com" }] } as unknown as JsonBody,
      });
      expect(res.status).toBe(400);
    });

    it("clears all rules with empty array", async () => {
      const res = await api("PUT", `/api/links/${targetLinkId}/targets`, {
        headers,
        body: { targets: [] } as unknown as JsonBody,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[] };
      expect(json.data).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Search SQL wildcard escaping (Task 17)
  // -----------------------------------------------------------------------
  describe("GET /api/links – search wildcard escaping", () => {
    it("search for % matches a literal percent and does not act as a wildcard", async () => {
      const unique = crypto.randomUUID().slice(0, 8);
      const percentSlug = `has-percent-${unique}%sign`;
      const normalSlug = `normal-link-${unique}`;
      await createTestLink(env.DB, { slug: percentSlug, userId });
      await createTestLink(env.DB, { slug: normalSlug, userId });

      // ?q=%25 decodes to a single literal "%". With correct LIKE escaping this
      // matches only slugs containing a literal "%", not every row (which is what
      // an unescaped "%" wildcard would return).
      const res = await api("GET", "/api/links?q=%25", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      const slugs = json.data.map((l) => l.slug);

      // Positive: the literal-percent slug IS found (guards against the escaping
      // being so aggressive it matches nothing — the previous vacuous-pass bug).
      expect(slugs).toContain(percentSlug);
      // Negative: a slug without a "%" is NOT returned, proving "%" is not a wildcard.
      expect(slugs).not.toContain(normalSlug);
      // Every result must contain a literal "%".
      expect(json.data.length).toBeGreaterThan(0);
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
      await createTestLink(env.DB, { slug: literalSlug, userId });
      await createTestLink(env.DB, { slug: wildcardOnlySlug, userId });

      const res = await api("GET", "/api/links?q=_underscore_", { headers });
      const json = await res.json() as { data: { slug: string }[] };
      const slugs = json.data.map((l) => l.slug);

      expect(slugs).toContain(literalSlug);
      expect(slugs).not.toContain(wildcardOnlySlug);
      expect(json.data.length).toBeGreaterThan(0);
      for (const item of json.data) {
        expect(item.slug).toContain("_underscore_");
      }
    });

    it("search matches destinationUrl (not just slug/title)", async () => {
      const unique = crypto.randomUUID().slice(0, 8);
      await createTestLink(env.DB, { slug: `url-search-${unique}`, userId, destinationUrl: `https://uniquehost-${unique}.example.com` });

      const res = await api("GET", `/api/links?q=uniquehost-${unique}`, { headers });
      const json = await res.json() as { data: { slug: string }[] };
      expect(json.data.some((l) => l.slug === `url-search-${unique}`)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Sort and pagination edge cases (Task 18)
  // -----------------------------------------------------------------------
  describe("GET /api/links – sort and pagination", () => {
    beforeAll(async () => {
      // Create a few links with different slugs and titles
      for (const suffix of ["alpha", "beta", "gamma"]) {
        await createTestLink(env.DB, {
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

    it("clamps page=0 to page 1", async () => {
      const res = await api("GET", "/api/links?page=0", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { pagination: { page: number } };
      expect(json.pagination.page).toBe(1);
    });

    it("clamps limit=0 to default (20)", async () => {
      const res = await api("GET", "/api/links?limit=0", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { pagination: { limit: number } };
      // Number(0) || 20 = 20 (falsy fallback to default)
      expect(json.pagination.limit).toBe(20);
    });

    it("clamps limit=101 to 100", async () => {
      const res = await api("GET", "/api/links?limit=101", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { pagination: { limit: number } };
      expect(json.pagination.limit).toBe(100);
    });

    it("treats page=abc as page 1", async () => {
      const res = await api("GET", "/api/links?page=abc", { headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { pagination: { page: number } };
      expect(json.pagination.page).toBe(1);
    });
  });
});
