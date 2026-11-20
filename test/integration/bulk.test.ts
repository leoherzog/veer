import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
  setupAuth, newUser, uniq, createTestLink, createTestDomain, createTestTeam, api, cachedRedirect, type JsonBody,
} from "../helpers";
import { getCachedRedirect } from "../../src/services/kv-cache";
import { BULK_MAX } from "../../src/lib/limits";

type BulkResults = { results: { slug: string; id?: string; success: boolean; error?: string }[] };

const postBulk = (body: JsonBody, headers: Record<string, string>, ctx?: ExecutionContext) =>
  api("POST", "/api/bulk", { headers, body, ctx });

describe("Bulk Links API", () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
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

    it("creates BULK_MAX links in one request", async () => {
      const links = Array.from({ length: BULK_MAX }, () => ({ slug: uniq("bulk-max"), destinationUrl: "https://example.com" }));

      const res = await postBulk({ links }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results).toHaveLength(BULK_MAX);
      expect(json.results.every(r => r.success)).toBe(true);
    });

    it.each<[string, unknown, string]>([
      ["no body", undefined, "Invalid JSON body"],
      ["an invalid JSON body", "not valid json{{{", "Invalid JSON body"],
      ["a missing links field", { something: [] }, "links must be an array"],
      ["an empty links array", { links: [] }, "links array must not be empty"],
      [
        "more than BULK_MAX links",
        { links: Array.from({ length: BULK_MAX + 1 }, (_, i) => ({ slug: `over-limit-${i}`, destinationUrl: "https://example.com" })) },
        `Maximum ${BULK_MAX} links per request`,
      ],
      ["a non-string teamId", { teamId: 42, links: [{ slug: "bulk-bad-team", destinationUrl: "https://example.com" }] }, "teamId must be a string"],
    ])("rejects %s with 400", async (_label, body, error) => {
      const res = await api("POST", "/api/bulk", { headers, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
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
      const json = await res.json() as BulkResults;
      expect(json.results).toHaveLength(3);
      expect(json.results.every(r => !r.success)).toBe(true);
      expect(json.results[0].error).toContain("Slug may only contain");
      expect(json.results[1].error).toBe("destinationUrl must be an absolute http or https URL");
      expect(json.results[2].error).toBe("destinationUrl is required");
    });

    it("marks second occurrence of duplicate slug in batch as 'Duplicate slug in batch'", async () => {
      const res = await postBulk({
        links: [
          { slug: "intra-dup", destinationUrl: "https://example.com/first" },
          { slug: "intra-dup", destinationUrl: "https://example.com/second" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results).toHaveLength(2);
      expect(json.results[0].success).toBe(true);
      expect(json.results[1].success).toBe(false);
      expect(json.results[1].error).toBe("Duplicate slug in batch");
    });

    it("returns 'Slug already taken' for slug conflicting with existing link", async () => {
      const existing = await createTestLink({ userId });
      const res = await postBulk({
        links: [
          { slug: existing.slug, destinationUrl: "https://example.com/conflict" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results).toEqual([{ slug: existing.slug, success: false, error: "Slug already taken" }]);
    });

    it("checks each slug against its own domain and caches the created links under their domain keys", async () => {
      const hostname = "bulk-scope.example.com";
      await createTestDomain(hostname);
      const onDefault = await createTestLink({ userId });
      const onCustom = await createTestLink({ userId, domainHostname: hostname });

      const ctx = createExecutionContext();
      const res = await postBulk({
        links: [
          { slug: onDefault.slug, destinationUrl: "https://example.com/custom", domainHostname: hostname },
          { slug: onCustom.slug, destinationUrl: "https://example.com/taken", domainHostname: hostname },
          { slug: onCustom.slug, destinationUrl: "https://example.com/default" },
        ],
      }, headers, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results.map(r => r.success)).toEqual([true, false, true]);
      expect(json.results[1]).toEqual({ slug: onCustom.slug, success: false, error: "Slug already taken" });

      expect((await getCachedRedirect(env.KV, onDefault.slug, hostname))?.url).toBe("https://example.com/custom");
      expect((await getCachedRedirect(env.KV, onCustom.slug))?.url).toBe("https://example.com/default");
      // The existing links were inserted directly, so the batch wrote no entry for them.
      expect(await getCachedRedirect(env.KV, onDefault.slug)).toBeNull();
      expect(await getCachedRedirect(env.KV, onCustom.slug, hostname)).toBeNull();
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
      const json = await res.json() as BulkResults;
      expect(json.results.map(r => r.success)).toEqual([true, false, true]);
    });

    it("bulk with valid domainHostname succeeds", async () => {
      await createTestDomain("bulk-domain.example.com", { accessMode: "all" });

      const res = await postBulk({
        links: [
          { slug: "bulk-dom-ok", destinationUrl: "https://example.com/d", domainHostname: "bulk-domain.example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results[0].success).toBe(true);
    });

    it("reports the access error on every item for a restricted domain", async () => {
      await createTestDomain("bulk-denied-cache.example.com", { accessMode: "restricted" });

      const res = await postBulk({
        links: [
          { slug: "bulk-denied-1", destinationUrl: "https://example.com/1", domainHostname: "bulk-denied-cache.example.com" },
          { slug: "bulk-denied-2", destinationUrl: "https://example.com/2", domainHostname: "bulk-denied-cache.example.com" },
          { slug: "bulk-denied-3", destinationUrl: "https://example.com/3", domainHostname: "bulk-denied-cache.example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results).toHaveLength(3);
      for (const result of json.results) {
        expect(result.success).toBe(false);
        expect(result.error).toBe("You do not have access to this domain");
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
      const json = await res.json() as BulkResults;
      // The cached verdict must carry the first item's message, not a generic access error.
      expect(json.results[0].error).toBe("Domain not found");
      expect(json.results[1].error).toBe("Domain not found");
    });

    it("stores the primary hostname as the default domain", async () => {
      const res = await postBulk({
        links: [{ slug: "bulk-primary-host", destinationUrl: "https://example.com/p", domainHostname: "localhost" }],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results[0].success).toBe(true);

      const row = await env.DB.prepare("SELECT domainHostname FROM links WHERE id = ?")
        .bind(json.results[0].id).first<{ domainHostname: string | null }>();
      expect(row!.domainHostname).toBeNull();
    });

    it("rejects an internal link on a custom domain per item", async () => {
      await createTestDomain("bulk-internal.example.com", { accessMode: "all" });

      const res = await postBulk({
        links: [
          { slug: "bulk-internal-bad", destinationUrl: "https://example.com/i", domainHostname: "bulk-internal.example.com", isInternal: true },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results[0].success).toBe(false);
      expect(json.results[0].error).toBe("Internal links are only supported on the default domain");
    });

    it("reports a non-object entry per item and still creates the rest", async () => {
      const res = await postBulk({
        links: [null, "bulk-string-entry", { slug: "bulk-after-null", destinationUrl: "https://example.com/n" }],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results[0]).toEqual({ slug: "", success: false, error: "Invalid link entry" });
      expect(json.results[1]).toEqual({ slug: "", success: false, error: "Invalid link entry" });
      expect(json.results[2].success).toBe(true);
    });

    it("reports the canonical slug once it validates and the raw input otherwise", async () => {
      const res = await postBulk({
        links: [
          { slug: "Bulk-Canon-URL", destinationUrl: "not-a-url" },
          { slug: "Bulk Canon Bad", destinationUrl: "https://example.com" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results.map(r => r.slug)).toEqual(["bulk-canon-url", "Bulk Canon Bad"]);
    });

    it("rejects a non-string title per item", async () => {
      const res = await postBulk({
        links: [
          { slug: "bulk-title-type", destinationUrl: "https://example.com", title: 42 },
          { slug: "bulk-title-ok", destinationUrl: "https://example.com", title: "Fine" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results[0]).toEqual({ slug: "bulk-title-type", success: false, error: "title must be a string" });
      expect(json.results[1].success).toBe(true);
    });

    it("caches each created link with the schema defaults", async () => {
      const ctx = createExecutionContext();
      const res = await postBulk({
        links: [{ slug: "Bulk-KV-Entry", destinationUrl: "https://example.com/kv", redirectType: 301 }],
      }, headers, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      const json = await res.json() as { results: { success: boolean; slug: string; id: string }[] };
      expect(json.results[0]).toMatchObject({ success: true, slug: "bulk-kv-entry" });

      const cached = await env.KV.get("bulk-kv-entry", { type: "json" });
      expect(cached).toEqual(cachedRedirect({
        url: "https://example.com/kv",
        redirectType: 301,
        linkId: json.results[0].id,
      }));
    });

    it("enforces the creator's maxLinks quota across the batch", async () => {
      const quotaAuth = await setupAuth({ maxLinks: 2 });
      await createTestLink({ userId: quotaAuth.user.id });

      const res = await postBulk({
        links: [
          { slug: "bulk-quota-1", destinationUrl: "https://example.com/1" },
          { slug: "bulk-quota-2", destinationUrl: "https://example.com/2" },
        ],
      }, quotaAuth.headers);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "You have reached your link limit (2)" });

      const row = await env.DB.prepare("SELECT id FROM links WHERE slug = ?").bind("bulk-quota-1").first();
      expect(row).toBeNull();
    });

    it("allows a batch that exactly fills the quota", async () => {
      const quotaAuth = await setupAuth({ maxLinks: 2 });

      const res = await postBulk({
        links: [
          { slug: "bulk-fit-1", destinationUrl: "https://example.com/1" },
          { slug: "bulk-fit-2", destinationUrl: "https://example.com/2" },
        ],
      }, quotaAuth.headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results.every(r => r.success)).toBe(true);
    });
  });

  describe("POST /api/bulk with teamId", () => {
    it("creates every link with the teamId for a team member", async () => {
      const team = await createTestTeam(userId, "member");

      const res = await postBulk({
        teamId: team.id,
        links: [
          { slug: uniq("bulk-team"), destinationUrl: "https://example.com/t1" },
          { slug: uniq("bulk-team"), destinationUrl: "https://example.com/t2" },
        ],
      }, headers);
      expect(res.status).toBe(200);
      const json = await res.json() as BulkResults;
      expect(json.results.every(r => r.success)).toBe(true);

      for (const { id } of json.results) {
        const row = await env.DB.prepare("SELECT teamId FROM links WHERE id = ?").bind(id).first<{ teamId: string | null }>();
        expect(row!.teamId).toBe(team.id);
      }
    });

    it("404s a non-member and inserts nothing", async () => {
      const outsider = await newUser("bulk-outsider");
      const team = await createTestTeam(outsider.user.id);
      const slug = uniq("bulk-team-denied");

      const res = await postBulk({ teamId: team.id, links: [{ slug, destinationUrl: "https://example.com/t" }] }, headers);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Team not found" });
      expect(await env.DB.prepare("SELECT id FROM links WHERE slug = ?").bind(slug).first()).toBeNull();
    });
  });
});
