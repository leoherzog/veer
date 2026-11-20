import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestDomain, createTestLink, mockExecutionCtx, api, newAdmin } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a domain_access row. */
async function createDomainAccess(hostname: string, email: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO domain_access (hostname, email) VALUES (?, ?)`
  )
    .bind(hostname, email.toLowerCase())
    .run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Domains API", () => {
  // Regular (non-admin) user
  let userHeaders: Record<string, string>;
  let userEmail: string;

  // Admin user
  let adminHeaders: Record<string, string>;
  let adminEnvObj: typeof env;

  beforeAll(async () => {
    const userAuth = await setupAuth({ email: "domains-user@test.com" });
    userHeaders = userAuth.headers;
    userEmail = userAuth.user.email;

    const admin = await newAdmin();
    adminHeaders = admin.headers;
    adminEnvObj = admin.env;
  });

  // -----------------------------------------------------------------------
  // LIST  GET /api/domains
  // -----------------------------------------------------------------------
  describe("GET /api/domains", () => {
    it("admin sees all domains", async () => {
      await createTestDomain("all-visible.example.com");
      await createTestDomain("restricted-visible.example.com", { accessMode: "restricted" });

      const res = await api("GET", "/api/domains", {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string }[] };
      const hostnames = json.data.map((d) => d.hostname);
      expect(hostnames).toContain("all-visible.example.com");
      expect(hostnames).toContain("restricted-visible.example.com");
    });

    it("non-admin user sees only accessMode=all domains", async () => {
      await createTestDomain("open-domain.example.com", { accessMode: "all" });
      await createTestDomain("closed-domain.example.com", { accessMode: "restricted" });

      const res = await api("GET", "/api/domains", { headers: userHeaders });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string; accessMode: string }[] };
      const hostnames = json.data.map((d) => d.hostname);
      expect(hostnames).toContain("open-domain.example.com");
      expect(hostnames).not.toContain("closed-domain.example.com");
    });

    it("non-admin user sees restricted domain they have explicit access to", async () => {
      const hostname = "user-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, userEmail);

      const res = await api("GET", "/api/domains", { headers: userHeaders });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string }[] };
      const hostnames = json.data.map((d) => d.hostname);
      expect(hostnames).toContain(hostname);
    });

    it("flags the primary hostname with isPrimary", async () => {
      // BETTER_AUTH_URL is http://localhost:8787 in the test env.
      await createTestDomain("localhost");
      await createTestDomain("not-primary.example.com");

      const res = await api("GET", "/api/domains", { headers: userHeaders });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string; isPrimary: boolean }[] };
      expect(json.data.find((d) => d.hostname === "localhost")!.isPrimary).toBe(true);
      expect(json.data.find((d) => d.hostname === "not-primary.example.com")!.isPrimary).toBe(false);
    });

    it("admin listing also carries isPrimary", async () => {
      await createTestDomain("localhost");

      const res = await api("GET", "/api/domains", { headers: adminHeaders, env: adminEnvObj });
      const json = await res.json() as { data: { hostname: string; isPrimary: boolean }[] };
      expect(json.data.find((d) => d.hostname === "localhost")!.isPrimary).toBe(true);
      expect(json.data.every((d) => typeof d.isPrimary === "boolean")).toBe(true);
    });

    it("response includes required fields", async () => {
      const hostname = "fields-check.example.com";
      await createTestDomain(hostname, {
        rootRedirect: "https://root.example.com",
        accessMode: "all",
      });

      const res = await api("GET", "/api/domains", { headers: userHeaders });
      const json = await res.json() as { data: { hostname: string; accessMode: string; rootRedirect: string | null; notFoundRedirect: string | null; updatedAt: number }[] };
      const domain = json.data.find((d) => d.hostname === hostname);
      expect(domain).toBeDefined();
      expect(domain!.hostname).toBe(hostname);
      expect(domain!.accessMode).toBe("all");
      expect(domain!.rootRedirect).toBe("https://root.example.com");
    });
  });

  // -----------------------------------------------------------------------
  // GET DETAIL  GET /api/domains/:hostname
  // -----------------------------------------------------------------------
  describe("GET /api/domains/:hostname", () => {
    it("returns 403 for non-admin user", async () => {
      const hostname = "detail-forbidden.example.com";
      await createTestDomain(hostname);

      const res = await api("GET", `/api/domains/${hostname}`, {
        headers: userHeaders,
      });
      expect(res.status).toBe(403);
    });

    it("admin gets domain detail with accessEmails", async () => {
      const hostname = "detail-admin.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, "member@test.com");

      const res = await api("GET", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: {
          hostname: string;
          accessMode: string;
          accessEmails: string[];
        };
      };
      expect(json.data.hostname).toBe(hostname);
      expect(json.data.accessMode).toBe("restricted");
      expect(json.data.accessEmails).toContain("member@test.com");
    });

    it("returns 404 for non-existent domain", async () => {
      const res = await api("GET", "/api/domains/nonexistent.example.com", {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(404);
    });

    it("hostname lookup is case-insensitive", async () => {
      const hostname = "case-detail.example.com";
      await createTestDomain(hostname);

      // Request with uppercase — domain routes lowercase the param
      const res = await api("GET", `/api/domains/CASE-DETAIL.EXAMPLE.COM`, {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string } };
      expect(json.data.hostname).toBe(hostname);
    });
  });

  // -----------------------------------------------------------------------
  // UPDATE CONFIG  PUT /api/domains/:hostname
  // -----------------------------------------------------------------------
  describe("PUT /api/domains/:hostname", () => {
    it("returns 403 for non-admin user", async () => {
      const hostname = "put-forbidden.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: userHeaders,
        body: { accessMode: "restricted" },
      });
      expect(res.status).toBe(403);
    });

    it("admin can update accessMode", async () => {
      const hostname = "update-mode.example.com";
      await createTestDomain(hostname, { accessMode: "all" });

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { accessMode: "restricted" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { accessMode: string } };
      expect(json.data.accessMode).toBe("restricted");
    });

    it("admin can set rootRedirect", async () => {
      const hostname = "update-root.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { rootRedirect: "https://mysite.com" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { rootRedirect: string | null } };
      expect(json.data.rootRedirect).toBe("https://mysite.com");
    });

    it("admin can clear rootRedirect by setting null", async () => {
      const hostname = "clear-root.example.com";
      await createTestDomain(hostname, { rootRedirect: "https://old.com" });

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { rootRedirect: null },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { rootRedirect: string | null } };
      expect(json.data.rootRedirect).toBeNull();
    });

    it("admin can set notFoundRedirect", async () => {
      const hostname = "update-notfound.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { notFoundRedirect: "https://404.example.com" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { notFoundRedirect: string | null } };
      expect(json.data.notFoundRedirect).toBe("https://404.example.com");
    });

    it("returns 400 when no body is sent", async () => {
      const hostname = "no-body-put.example.com";
      await createTestDomain(hostname);

      const res = await app.request(`/api/domains/${hostname}`, {
        method: "PUT",
        headers: adminHeaders,
      }, adminEnvObj, mockExecutionCtx());
      expect(res.status).toBe(400);
    });

    it("rejects invalid accessMode with 400", async () => {
      const hostname = "invalid-mode.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { accessMode: "public" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-http redirect URL with 400", async () => {
      const hostname = "bad-redirect.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { rootRedirect: "ftp://bad.example.com" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects malformed redirect URL with 400", async () => {
      const hostname = "malformed-redirect.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { rootRedirect: "not-a-url" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent domain", async () => {
      const res = await api("PUT", "/api/domains/nonexistent.example.com", {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { accessMode: "all" },
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // SET ACCESS  PUT /api/domains/:hostname/access
  // -----------------------------------------------------------------------
  describe("PUT /api/domains/:hostname/access", () => {
    it("returns 403 for non-admin user", async () => {
      const hostname = "set-access-forbidden.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: userHeaders,
        body: { emails: ["user@test.com"] },
      });
      expect(res.status).toBe(403);
    });

    it("admin sets access emails, replacing existing ones", async () => {
      const hostname = "set-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, "old@test.com");

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { emails: ["new1@test.com", "new2@test.com"] },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toContain("new1@test.com");
      expect(json.data).toContain("new2@test.com");
      expect(json.data).not.toContain("old@test.com");

      // Read back persisted state — guards against a PUT that only echoes the input
      const getRes = await api("GET", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      const getJson = await getRes.json() as { data: { accessEmails: string[] } };
      expect(getJson.data.accessEmails).toContain("new1@test.com");
      expect(getJson.data.accessEmails).toContain("new2@test.com");
      expect(getJson.data.accessEmails).not.toContain("old@test.com");
    });

    it("admin can clear access by setting empty array", async () => {
      const hostname = "clear-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, "someone@test.com");

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { emails: [] },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toEqual([]);

      // Read back persisted state — the pre-seeded row must actually be deleted, not just
      // absent from the echoed response
      const row = await env.DB.prepare(
        "SELECT email FROM domain_access WHERE hostname = ? AND email = ?"
      ).bind(hostname, "someone@test.com").first();
      expect(row).toBeNull();

      const getRes = await api("GET", `/api/domains/${hostname}`, {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      const getJson = await getRes.json() as { data: { accessEmails: string[] } };
      expect(getJson.data.accessEmails).toEqual([]);
    });

    it("emails are normalized to lowercase", async () => {
      const hostname = "lowercase-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { emails: ["UPPER@Test.COM"] },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toContain("upper@test.com");
    });

    it("stores an email once when it repeats in a different case", async () => {
      const hostname = "dedupe-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { emails: ["dup@test.com", "DUP@Test.com", " dup@test.com ", "other@test.com"] },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: ["dup@test.com", "other@test.com"] });

      const { results } = await env.DB.prepare("SELECT email FROM domain_access WHERE hostname = ? ORDER BY email")
        .bind(hostname).all<{ email: string }>();
      expect(results.map(r => r.email)).toEqual(["dup@test.com", "other@test.com"]);
    });

    it("rejects missing emails field with 400", async () => {
      const hostname = "access-missing-emails.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: {},
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-array emails with 400", async () => {
      const hostname = "access-bad-type.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { emails: "not-an-array" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid email format with 400", async () => {
      const hostname = "access-bad-email.example.com";
      await createTestDomain(hostname);

      const res = await api("PUT", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { emails: ["not-an-email"] },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent domain", async () => {
      const res = await api("PUT", "/api/domains/nonexistent.example.com/access", {
        headers: adminHeaders,
        env: adminEnvObj,
        body: { emails: [] },
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // SYNC  POST /api/domains/sync
  // -----------------------------------------------------------------------
  describe("POST /api/domains/sync", () => {
    /** Stub the Cloudflare workers-domains API with a fixed hostname list. */
    function stubCloudflareDomains(hostnames: string[]) {
      return vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          result: hostnames.map((hostname) => ({ hostname })),
          result_info: { total_pages: 1 },
        })
      );
    }

    /** Admin env plus the Cloudflare API credentials sync requires. */
    function syncEnv() {
      return { ...adminEnvObj, CF_ACCOUNT_ID: "test-account-id", CF_API_TOKEN: "test-api-token" };
    }

    it("returns 403 for non-admin user", async () => {
      const fetchSpy = stubCloudflareDomains([]);

      const res = await api("POST", "/api/domains/sync", {
        headers: userHeaders,
        env: { ...env, CF_ACCOUNT_ID: "test-account-id", CF_API_TOKEN: "test-api-token" },
      });

      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("removes a dropped domain's links instead of moving them onto the primary host", async () => {
      const removed = "sync-removed.example.com";
      await createTestDomain(removed);
      const userAuth = await setupAuth({ email: "sync-links@test.com" });
      const customLink = await createTestLink({
        slug: "sync-collide",
        userId: userAuth.user.id,
        domainHostname: removed,
      });
      const primaryLink = await createTestLink({
        slug: "sync-collide",
        userId: userAuth.user.id,
        domainHostname: null,
      });
      await env.KV.put(`${removed}:sync-collide`, JSON.stringify({ url: "https://example.com" }));

      stubCloudflareDomains(["kept.example.com"]);

      const res = await api("POST", "/api/domains/sync", {
        headers: adminHeaders,
        env: syncEnv(),
      });
      expect(res.status).toBe(200);

      const domainRow = await env.DB.prepare("SELECT hostname FROM domain_config WHERE hostname = ?")
        .bind(removed).first();
      expect(domainRow).toBeNull();

      const goneLink = await env.DB.prepare("SELECT id FROM links WHERE id = ?").bind(customLink.id).first();
      expect(goneLink).toBeNull();

      const keptLink = await env.DB.prepare("SELECT domainHostname FROM links WHERE id = ?")
        .bind(primaryLink.id).first<{ domainHostname: string | null }>();
      expect(keptLink).not.toBeNull();
      expect(keptLink!.domainHostname).toBeNull();

      expect(await env.KV.get(`${removed}:sync-collide`)).toBeNull();
    });

    it("purges the cached links of every removed domain", async () => {
      const removedA = "sync-removed-a.example.com";
      const removedB = "sync-removed-b.example.com";
      await createTestDomain(removedA);
      await createTestDomain(removedB);
      const owner = await setupAuth({ email: "sync-multi@test.com" });
      const linkA = await createTestLink({ slug: "sync-multi-a", userId: owner.user.id, domainHostname: removedA });
      const linkB = await createTestLink({ slug: "sync-multi-b", userId: owner.user.id, domainHostname: removedB });
      await env.KV.put(`${removedA}:sync-multi-a`, JSON.stringify({ url: "https://example.com/a" }));
      await env.KV.put(`${removedB}:sync-multi-b`, JSON.stringify({ url: "https://example.com/b" }));

      stubCloudflareDomains(["kept.example.com"]);

      const res = await api("POST", "/api/domains/sync", { headers: adminHeaders, env: syncEnv() });
      expect(res.status).toBe(200);
      const hostnames = (await res.json() as { data: { hostname: string }[] }).data.map(d => d.hostname);
      expect(hostnames).not.toContain(removedA);
      expect(hostnames).not.toContain(removedB);

      for (const id of [linkA.id, linkB.id]) {
        expect(await env.DB.prepare("SELECT id FROM links WHERE id = ?").bind(id).first()).toBeNull();
      }
      expect(await env.KV.get(`${removedA}:sync-multi-a`)).toBeNull();
      expect(await env.KV.get(`${removedB}:sync-multi-b`)).toBeNull();
    });

    it("removes more domains than one statement can bind", async () => {
      // D1 caps a statement at 100 bound parameters.
      const removed = Array.from({ length: 120 }, (_, i) => `sync-many-${String(i).padStart(3, "0")}.example.com`);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.batch(removed.map(hostname =>
        env.DB.prepare("INSERT INTO domain_config (hostname, accessMode, updatedAt) VALUES (?, 'all', ?)").bind(hostname, now),
      ));
      const owner = await setupAuth({ email: "sync-many@test.com" });
      const edges = [removed[0], removed[removed.length - 1]];
      for (const hostname of edges) {
        await createTestLink({ slug: "sync-many", userId: owner.user.id, domainHostname: hostname });
        await env.KV.put(`${hostname}:sync-many`, JSON.stringify({ url: "https://example.com" }));
      }

      stubCloudflareDomains(["kept.example.com"]);

      const res = await api("POST", "/api/domains/sync", { headers: adminHeaders, env: syncEnv() });
      expect(res.status).toBe(200);
      const hostnames = new Set((await res.json() as { data: { hostname: string }[] }).data.map(d => d.hostname));
      expect(removed.filter(h => hostnames.has(h))).toEqual([]);
      for (const hostname of edges) {
        expect(await env.KV.get(`${hostname}:sync-many`)).toBeNull();
      }
    });

    it("asks Cloudflare for the domains of the configured Worker", async () => {
      const fetchSpy = stubCloudflareDomains([]);

      const res = await api("POST", "/api/domains/sync", { headers: adminHeaders, env: syncEnv() });
      expect(res.status).toBe(200);
      const url = new URL(String(fetchSpy.mock.calls[0][0]));
      expect(url.searchParams.get("service")).toBe(env.WORKER_NAME);
    });

    it("inserts new hostnames and always keeps the primary host", async () => {
      stubCloudflareDomains(["fresh-sync.example.com"]);

      const res = await api("POST", "/api/domains/sync", {
        headers: adminHeaders,
        env: syncEnv(),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string }[] };
      const hostnames = json.data.map((d) => d.hostname);
      expect(hostnames).toContain("fresh-sync.example.com");
      expect(hostnames).toContain("localhost");
    });
  });
});
