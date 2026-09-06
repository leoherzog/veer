import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, mockExecutionCtx, createTestDomain, type JsonBody } from "../helpers";

async function postBulk(body: JsonBody, headers: Record<string, string>) {
  return app.request("/api/bulk", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env, mockExecutionCtx());
}

describe("Bulk Links API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth(env);
    headers = auth.headers;
    userId = auth.user.id;
  });

  describe("POST /api/bulk", () => {
    it("creates 3 links successfully, all return success:true with ids", async () => {
      const res = await postBulk({
        links: [
          { slug: "bulk-a", destinationUrl: "https://example.com/a" },
          { slug: "bulk-b", destinationUrl: "https://example.com/b", title: "B Link" },
          { slug: "bulk-c", destinationUrl: "https://example.com/c", redirectType: 301 },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; id: string; success: boolean }[] };
      expect(json.results).toHaveLength(3);
      for (const result of json.results) {
        expect(result.success).toBe(true);
        expect(typeof result.id).toBe("string");
        expect(result.id.length).toBeGreaterThan(0);
      }
      expect(json.results[0].slug).toBe("bulk-a");
      expect(json.results[1].slug).toBe("bulk-b");
      expect(json.results[2].slug).toBe("bulk-c");
    });

    it("returns 400 when no body is sent", async () => {
      const res = await app.request("/api/bulk", {
        method: "POST",
        headers,
      }, env, mockExecutionCtx());
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await app.request("/api/bulk", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "not valid json{{{",
      }, env);
      expect(res.status).toBe(400);
    });

    it("returns 400 when links field is missing", async () => {
      const res = await postBulk({ something: [] }, headers);
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty links array", async () => {
      const res = await postBulk({ links: [] }, headers);
      expect(res.status).toBe(400);
    });

    it("returns 400 when links array exceeds 50 items", async () => {
      const links = Array.from({ length: 51 }, (_, i) => ({
        slug: `over-limit-${i}`,
        destinationUrl: "https://example.com",
      }));
      const res = await postBulk({ links }, headers);
      expect(res.status).toBe(400);
    });

    it("returns per-item errors for invalid slug, invalid URL, and missing destinationUrl", async () => {
      const res = await postBulk({
        links: [
          { slug: "has space", destinationUrl: "https://example.com" },
          { slug: "bad-url", destinationUrl: "not-a-url" },
          { slug: "missing-dest" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean; error?: string }[] };
      expect(json.results).toHaveLength(3);
      expect(json.results[0].success).toBe(false);
      expect(json.results[0].error).toBeTruthy();
      expect(json.results[1].success).toBe(false);
      expect(json.results[1].error).toBeTruthy();
      expect(json.results[2].success).toBe(false);
      expect(json.results[2].error).toBeTruthy();
    });

    it("marks second occurrence of duplicate slug in batch as 'Duplicate slug in batch'", async () => {
      const res = await postBulk({
        links: [
          { slug: "intra-dup", destinationUrl: "https://example.com/first" },
          { slug: "intra-dup", destinationUrl: "https://example.com/second" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean; error?: string }[] };
      expect(json.results).toHaveLength(2);
      expect(json.results[0].success).toBe(true);
      expect(json.results[1].success).toBe(false);
      expect(json.results[1].error).toBe("Duplicate slug in batch");
    });

    it("returns 'Slug already taken' for slug conflicting with existing link", async () => {
      await createTestLink(env.DB, { slug: "existing-bulk-slug", userId });
      const res = await postBulk({
        links: [
          { slug: "existing-bulk-slug", destinationUrl: "https://example.com/conflict" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean; error?: string }[] };
      expect(json.results).toHaveLength(1);
      expect(json.results[0].success).toBe(false);
      expect(json.results[0].error).toBe("Slug already taken");
    });

    it("handles mixed results: some succeed, some fail validation", async () => {
      const res = await postBulk({
        links: [
          { slug: "mixed-ok-1", destinationUrl: "https://example.com/ok1" },
          { slug: "bad url", destinationUrl: "https://example.com" },
          { slug: "mixed-ok-2", destinationUrl: "https://example.com/ok2" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean; error?: string }[] };
      expect(json.results).toHaveLength(3);
      expect(json.results[0].success).toBe(true);
      expect(json.results[1].success).toBe(false);
      expect(json.results[2].success).toBe(true);
    });

    it("bulk with valid domainHostname succeeds", async () => {
      await createTestDomain(env.DB, "bulk-domain.example.com", { accessMode: "all" });

      const res = await postBulk({
        links: [
          { slug: "bulk-dom-ok", destinationUrl: "https://example.com/d", domainHostname: "bulk-domain.example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean }[] };
      expect(json.results[0].success).toBe(true);
    });

    it("bulk with non-existent domainHostname returns per-item error", async () => {
      const res = await postBulk({
        links: [
          { slug: "bulk-dom-bad", destinationUrl: "https://example.com/d", domainHostname: "nonexistent.example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean; error?: string }[] };
      expect(json.results[0].success).toBe(false);
      expect(json.results[0].error).toBe("Domain not found");
    });

    it("bulk with restricted domain without access returns per-item error", async () => {
      await createTestDomain(env.DB, "bulk-restricted.example.com", { accessMode: "restricted" });

      const res = await postBulk({
        links: [
          { slug: "bulk-dom-restricted", destinationUrl: "https://example.com/d", domainHostname: "bulk-restricted.example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean; error?: string }[] };
      expect(json.results[0].success).toBe(false);
      expect(json.results[0].error).toContain("access");
    });

    it("multiple items with same denied domain all fail (cached short-circuit)", async () => {
      await createTestDomain(env.DB, "bulk-denied-cache.example.com", { accessMode: "restricted" });

      const res = await postBulk({
        links: [
          { slug: "bulk-denied-1", destinationUrl: "https://example.com/1", domainHostname: "bulk-denied-cache.example.com" },
          { slug: "bulk-denied-2", destinationUrl: "https://example.com/2", domainHostname: "bulk-denied-cache.example.com" },
          { slug: "bulk-denied-3", destinationUrl: "https://example.com/3", domainHostname: "bulk-denied-cache.example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { slug: string; success: boolean; error?: string }[] };
      expect(json.results).toHaveLength(3);
      for (const result of json.results) {
        expect(result.success).toBe(false);
        expect(result.error).toContain("access");
      }
    });

    it("reports the real reason for every item on an unknown domain", async () => {
      const res = await postBulk({
        links: [
          { slug: "bulk-missing-dom-1", destinationUrl: "https://example.com/1", domainHostname: "missing-cache.example.com" },
          { slug: "bulk-missing-dom-2", destinationUrl: "https://example.com/2", domainHostname: "missing-cache.example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { success: boolean; error?: string }[] };
      // The cached verdict must carry the first item's message, not a generic access error.
      expect(json.results[0].error).toBe("Domain not found");
      expect(json.results[1].error).toBe("Domain not found");
    });

    it("stores the primary hostname as the default domain", async () => {
      const res = await postBulk({
        links: [{ slug: "bulk-primary-host", destinationUrl: "https://example.com/p", domainHostname: "localhost" }],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { success: boolean; id: string }[] };
      expect(json.results[0].success).toBe(true);

      const row = await env.DB.prepare("SELECT domainHostname FROM links WHERE id = ?")
        .bind(json.results[0].id).first<{ domainHostname: string | null }>();
      expect(row!.domainHostname).toBeNull();
    });

    it("rejects an internal link on a custom domain per item", async () => {
      await createTestDomain(env.DB, "bulk-internal.example.com", { accessMode: "all" });

      const res = await postBulk({
        links: [
          { slug: "bulk-internal-bad", destinationUrl: "https://example.com/i", domainHostname: "bulk-internal.example.com", isInternal: true },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { success: boolean; error?: string }[] };
      expect(json.results[0].success).toBe(false);
      expect(json.results[0].error).toContain("Internal links");
    });

    it("rejects a non-string teamId with 400", async () => {
      const res = await postBulk({
        teamId: 42,
        links: [{ slug: "bulk-bad-team", destinationUrl: "https://example.com" }],
      }, headers);
      expect(res.status).toBe(400);
    });

    it("enforces the creator's maxLinks quota across the batch", async () => {
      const quotaAuth = await setupAuth(env, { email: "bulk-quota@test.com" });
      await createTestLink(env.DB, { slug: "bulk-quota-existing", userId: quotaAuth.user.id });
      await env.DB.prepare("UPDATE user SET maxLinks = 2 WHERE id = ?").bind(quotaAuth.user.id).run();

      const res = await postBulk({
        links: [
          { slug: "bulk-quota-1", destinationUrl: "https://example.com/1" },
          { slug: "bulk-quota-2", destinationUrl: "https://example.com/2" },
        ],
      }, quotaAuth.headers);
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toContain("link limit");

      const row = await env.DB.prepare("SELECT id FROM links WHERE slug = ?").bind("bulk-quota-1").first();
      expect(row).toBeNull();
    });

    it("allows a batch that exactly fills the quota", async () => {
      const quotaAuth = await setupAuth(env, { email: "bulk-quota-fit@test.com" });
      await env.DB.prepare("UPDATE user SET maxLinks = 2 WHERE id = ?").bind(quotaAuth.user.id).run();

      const res = await postBulk({
        links: [
          { slug: "bulk-fit-1", destinationUrl: "https://example.com/1" },
          { slug: "bulk-fit-2", destinationUrl: "https://example.com/2" },
        ],
      }, quotaAuth.headers);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { success: boolean }[] };
      expect(json.results.every(r => r.success)).toBe(true);
    });

    it("returns 401 for unauthenticated request", async () => {
      const res = await app.request("/api/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links: [{ slug: "noauth-bulk", destinationUrl: "https://example.com" }],
        }),
      }, env);
      expect(res.status).toBe(401);
    });
  });
});
