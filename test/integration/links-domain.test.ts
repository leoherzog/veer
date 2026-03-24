import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import app from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx } from "../helpers";

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
  return app.request(path, init, env, mockExecutionCtx());
}

async function postLink(body: JsonBody, headers: Record<string, string>) {
  return api("POST", "/api/links", { headers, body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Links API — domain-scoped operations", () => {
  let headers: Record<string, string>;
  let userId: string;
  let userEmail: string;

  beforeAll(async () => {
    const auth = await setupAuth(env, { email: "domain-links@test.com" });
    headers = auth.headers;
    userId = auth.user.id;
    userEmail = auth.user.email;
  });

  beforeEach(async () => {
    // Ensure domain_config rows exist for tests
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO domain_config (hostname, accessMode, updatedAt) VALUES (?, ?, ?)"
    ).bind("custom.example.com", "all", now).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO domain_config (hostname, accessMode, updatedAt) VALUES (?, ?, ?)"
    ).bind("restricted.example.com", "restricted", now).run();
  });

  // -------------------------------------------------------------------------
  // CREATE with domainHostname
  // -------------------------------------------------------------------------
  describe("POST /api/links with domainHostname", () => {
    it("creates a link on a valid domain", async () => {
      const res = await postLink({
        slug: "dom-create-ok",
        destinationUrl: "https://example.com/ok",
        domainHostname: "custom.example.com",
      }, headers);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { slug: string; domainHostname: string } };
      expect(json.data.slug).toBe("dom-create-ok");
      expect(json.data.domainHostname).toBe("custom.example.com");
    });

    it("rejects non-existent domain with 400", async () => {
      const res = await postLink({
        slug: "dom-nonexist",
        destinationUrl: "https://example.com",
        domainHostname: "nonexistent.example.com",
      }, headers);
      expect(res.status).toBe(400);
      const json = await res.json() as { message?: string; error?: string };
      const msg = json.message || json.error || "";
      expect(msg).toContain("Domain not found");
    });

    it("rejects restricted domain without access with 400", async () => {
      const res = await postLink({
        slug: "dom-restricted",
        destinationUrl: "https://example.com",
        domainHostname: "restricted.example.com",
      }, headers);
      expect(res.status).toBe(400);
      const json = await res.json() as { message?: string; error?: string };
      const msg = json.message || json.error || "";
      expect(msg).toContain("access");
    });

    it("allows same slug on different domains", async () => {
      // Create on default domain (no domainHostname)
      const res1 = await postLink({
        slug: "cross-dom-slug",
        destinationUrl: "https://example.com/default",
      }, headers);
      expect(res1.status).toBe(201);

      // Same slug on custom domain should succeed
      const res2 = await postLink({
        slug: "cross-dom-slug",
        destinationUrl: "https://example.com/custom",
        domainHostname: "custom.example.com",
      }, headers);
      expect(res2.status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // UPDATE with domainHostname
  // -------------------------------------------------------------------------
  describe("PUT /api/links/:id changing domainHostname", () => {
    it("updates domainHostname and KV key", async () => {
      const link = await createTestLink(env.DB, {
        slug: "dom-update-kv",
        userId,
        domainHostname: null,
      });

      // Write initial KV entry (bare slug key)
      await env.KV.put("dom-update-kv", JSON.stringify({ url: "https://example.com" }));

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { domainHostname: "custom.example.com" },
      });
      expect(res.status).toBe(200);

      // Old KV key (bare slug) should be deleted
      const oldKv = await env.KV.get("dom-update-kv");
      expect(oldKv).toBeNull();

      // New KV key (hostname:slug) should exist
      const newKv = await env.KV.get("custom.example.com:dom-update-kv");
      expect(newKv).not.toBeNull();
    });

    it("returns 409 when slug collides on target domain", async () => {
      // Create existing link on custom domain with slug "collision-slug"
      await createTestLink(env.DB, {
        slug: "collision-slug",
        userId,
        domainHostname: "custom.example.com",
      });
      // Write KV for it
      await env.KV.put("custom.example.com:collision-slug", JSON.stringify({ url: "https://example.com" }));

      // Create another link on default domain with same slug
      const link2 = await createTestLink(env.DB, {
        slug: "collision-slug",
        userId,
        domainHostname: null,
      });

      // Try to move link2 to custom.example.com — should conflict
      const res = await api("PUT", `/api/links/${link2.id}`, {
        headers,
        body: { domainHostname: "custom.example.com" },
      });
      expect(res.status).toBe(409);
    });
  });
});
