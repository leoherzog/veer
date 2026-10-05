import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { setupAuth, createTestLink, createTestDomain, api, postLink } from "../helpers";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Links API — domain-scoped operations", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth({ email: "domain-links@test.com" });
    headers = auth.headers;
    userId = auth.user.id;
    await createTestDomain("custom.example.com");
    await createTestDomain("restricted.example.com", { accessMode: "restricted" });
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
      const json = await res.json() as { error: string };
      expect(json.error).toContain("Domain not found");
    });

    it("rejects restricted domain without access with 400", async () => {
      const res = await postLink({
        slug: "dom-restricted",
        destinationUrl: "https://example.com",
        domainHostname: "restricted.example.com",
      }, headers);
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toContain("access");
    });

    it("treats the primary hostname as the default domain", async () => {
      // BETTER_AUTH_URL is http://localhost:8787 in the test env, so "localhost" is primary.
      const ctx = createExecutionContext();
      const res = await api("POST", "/api/links", {
        headers,
        body: { slug: "primary-host-link", destinationUrl: "https://example.com/primary", domainHostname: "localhost" },
        ctx,
      });
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { id: string; domainHostname: string | null } };
      expect(json.data.domainHostname).toBeNull();

      const row = await env.DB.prepare("SELECT domainHostname FROM links WHERE id = ?")
        .bind(json.data.id).first<{ domainHostname: string | null }>();
      expect(row!.domainHostname).toBeNull();

      // The redirect engine reads the bare slug key for primary-host links.
      expect(await env.KV.get("primary-host-link")).not.toBeNull();
      expect(await env.KV.get("localhost:primary-host-link")).toBeNull();
    });

    it("collides with an existing default-domain slug when given the primary hostname", async () => {
      await createTestLink({ slug: "primary-host-taken", userId, domainHostname: null });
      const res = await postLink({
        slug: "primary-host-taken",
        destinationUrl: "https://example.com",
        domainHostname: "localhost",
      }, headers);
      expect(res.status).toBe(409);
    });

    it("rejects an internal link on a custom domain with 400", async () => {
      const res = await postLink({
        slug: "internal-custom-domain",
        destinationUrl: "https://example.com/internal",
        domainHostname: "custom.example.com",
        isInternal: true,
      }, headers);
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toContain("Internal links");
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
      const link = await createTestLink({
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
      await createTestLink({
        slug: "collision-slug",
        userId,
        domainHostname: "custom.example.com",
      });
      // Write KV for it
      await env.KV.put("custom.example.com:collision-slug", JSON.stringify({ url: "https://example.com" }));

      // Create another link on default domain with same slug
      const link2 = await createTestLink({
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

    it("moving to the primary hostname clears domainHostname", async () => {
      const link = await createTestLink({
        slug: "move-to-primary",
        userId,
        domainHostname: "custom.example.com",
      });
      await env.KV.put("custom.example.com:move-to-primary", JSON.stringify({ url: "https://example.com" }));

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { domainHostname: "localhost" },
      });
      expect(res.status).toBe(200);

      const row = await env.DB.prepare("SELECT domainHostname FROM links WHERE id = ?")
        .bind(link.id).first<{ domainHostname: string | null }>();
      expect(row!.domainHostname).toBeNull();
      expect(await env.KV.get("custom.example.com:move-to-primary")).toBeNull();
      expect(await env.KV.get("move-to-primary")).not.toBeNull();
    });

    it("rejects making a custom-domain link internal with 400", async () => {
      const link = await createTestLink({
        slug: "internal-on-custom",
        userId,
        domainHostname: "custom.example.com",
      });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { isInternal: true },
      });
      expect(res.status).toBe(400);

      const row = await env.DB.prepare("SELECT isInternal FROM links WHERE id = ?")
        .bind(link.id).first<{ isInternal: number }>();
      expect(row!.isInternal).toBe(0);
    });

    it("rejects moving an internal link onto a custom domain with 400", async () => {
      const link = await createTestLink({
        slug: "internal-move",
        userId,
        isInternal: true,
      });

      const res = await api("PUT", `/api/links/${link.id}`, {
        headers,
        body: { domainHostname: "custom.example.com" },
      });
      expect(res.status).toBe(400);
    });
  });
});
