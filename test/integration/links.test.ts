import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import app from "../../src/index";
import { setupAuth, createTestLink } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

async function api(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: JsonBody } = {}
) {
  const init: RequestInit = { method, headers: opts.headers };
  if (opts.body) {
    init.body = JSON.stringify(opts.body);
  }
  return app.request(path, init, env);
}

/** Shorthand: POST /api/links with auth. */
async function postLink(body: JsonBody, headers: Record<string, string>) {
  return api("POST", "/api/links", { headers, body });
}

/** Insert a click stat row directly into D1 for the given link. */
async function insertClickStat(linkId: string, clicks: number, date = "2026-03-17") {
  await env.DB.prepare(
    "INSERT INTO link_stats (linkId, date, clicks, uniqueClicks) VALUES (?, ?, ?, ?)"
  ).bind(linkId, date, clicks, clicks).run();
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

    it("updates the slug and invalidates old KV entry", async () => {
      const link = await createTestLink(env.DB, { slug: "old-slug", userId });
      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { slug: "new-slug" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { slug: string } };
      expect(json.data.slug).toBe("new-slug");

      const oldKv = await env.KV.get("old-slug");
      expect(oldKv).toBeNull();
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

    it("returns 409 for slug conflict with existing link", async () => {
      await createTestLink(env.DB, { slug: "conflict-target", userId });
      const link = await createTestLink(env.DB, { slug: "conflict-source", userId });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { slug: "conflict-target" },
      });
      expect(res.status).toBe(409);
    });
  });

  // -----------------------------------------------------------------------
  // TOGGLE ACTIVE  PATCH /api/links/:id/active
  // -----------------------------------------------------------------------
  describe("PATCH /api/links/:id/active", () => {
    it("deactivates a link", async () => {
      const link = await createTestLink(env.DB, { slug: "deactivate-me", userId, isActive: true });
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
});
