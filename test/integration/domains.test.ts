import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { newUser, newAdmin, createTestDomain, createDomainAccess, createTestLink, api } from "../helpers";
import { getDb } from "../../src/db";
import { domainConfig } from "../../src/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stub the Cloudflare workers-domains API with one hostname list per page. A
 * fresh Response per call, since a body reads once and sync may fetch several pages.
 */
function stubCloudflareDomains(...pages: string[][]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    return Response.json({
      result: (pages[page - 1] ?? []).map((hostname) => ({ hostname })),
      result_info: { total_pages: pages.length },
    });
  });
}

const CF_CREDENTIALS = { CF_ACCOUNT_ID: "test-account-id", CF_API_TOKEN: "test-api-token" };

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
    const userAuth = await newUser("domains-user");
    userHeaders = userAuth.headers;
    userEmail = userAuth.user.email;

    const admin = await newAdmin();
    adminHeaders = admin.headers;
    adminEnvObj = admin.env;
  });

  /** As the admin, against the admin env. */
  const asAdmin = (method: string, path: string, body?: unknown) =>
    api(method, path, { headers: adminHeaders, env: adminEnvObj, body });

  // -----------------------------------------------------------------------
  // Everything but the list is admin-only
  // -----------------------------------------------------------------------
  describe("non-admin access", () => {
    const hostname = "forbidden.example.com";

    beforeAll(async () => {
      await createTestDomain(hostname, { accessMode: "all" });
    });

    it.each<[string, string, unknown]>([
      ["GET", `/api/domains/${hostname}`, undefined],
      ["PUT", `/api/domains/${hostname}`, { accessMode: "restricted" }],
      ["PUT", `/api/domains/${hostname}/access`, { emails: ["user@test.com"] }],
      ["POST", "/api/domains/sync", undefined],
    ])("%s %s returns 403 and changes nothing", async (method, path, body) => {
      const fetchSpy = stubCloudflareDomains([]);

      const res = await api(method, path, { headers: userHeaders, env: { ...env, ...CF_CREDENTIALS }, body });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
      expect(fetchSpy).not.toHaveBeenCalled();
      const row = await env.DB.prepare("SELECT accessMode FROM domain_config WHERE hostname = ?")
        .bind(hostname).first<{ accessMode: string }>();
      expect(row!.accessMode).toBe("all");
      expect(await env.DB.prepare("SELECT email FROM domain_access WHERE hostname = ?").bind(hostname).first()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // LIST  GET /api/domains
  // -----------------------------------------------------------------------
  describe("GET /api/domains", () => {
    it("admin sees all domains", async () => {
      await createTestDomain("all-visible.example.com");
      await createTestDomain("restricted-visible.example.com", { accessMode: "restricted" });

      const res = await asAdmin("GET", "/api/domains");
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
  // Every /:hostname route 404s a hostname with no config row
  // -----------------------------------------------------------------------
  it.each<[string, string, unknown]>([
    ["GET", "/api/domains/nonexistent.example.com", undefined],
    ["PUT", "/api/domains/nonexistent.example.com", { accessMode: "all" }],
    ["PUT", "/api/domains/nonexistent.example.com/access", { emails: [] }],
  ])("%s %s returns 404 for a domain with no config", async (method, path, body) => {
    const res = await asAdmin(method, path, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Domain not found" });
  });

  // -----------------------------------------------------------------------
  // GET DETAIL  GET /api/domains/:hostname
  // -----------------------------------------------------------------------
  describe("GET /api/domains/:hostname", () => {
    it("admin gets domain detail with accessEmails", async () => {
      const hostname = "detail-admin.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, "member@test.com");

      const res = await asAdmin("GET", `/api/domains/${hostname}`);
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

    it("hostname lookup is case-insensitive", async () => {
      const hostname = "case-detail.example.com";
      await createTestDomain(hostname);

      // Request with uppercase — domain routes lowercase the param
      const res = await asAdmin("GET", "/api/domains/CASE-DETAIL.EXAMPLE.COM");
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string } };
      expect(json.data.hostname).toBe(hostname);
    });
  });

  // -----------------------------------------------------------------------
  // UPDATE CONFIG  PUT /api/domains/:hostname
  // -----------------------------------------------------------------------
  describe("PUT /api/domains/:hostname", () => {
    it("admin can update accessMode", async () => {
      const hostname = "update-mode.example.com";
      await createTestDomain(hostname, { accessMode: "all" });

      const res = await asAdmin("PUT", `/api/domains/${hostname}`, { accessMode: "restricted" });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { accessMode: string } };
      expect(json.data.accessMode).toBe("restricted");
    });

    it("admin can set rootRedirect", async () => {
      const hostname = "update-root.example.com";
      await createTestDomain(hostname);

      const res = await asAdmin("PUT", `/api/domains/${hostname}`, { rootRedirect: "https://mysite.com" });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { rootRedirect: string | null } };
      expect(json.data.rootRedirect).toBe("https://mysite.com");
    });

    it("admin can clear rootRedirect by setting null", async () => {
      const hostname = "clear-root.example.com";
      await createTestDomain(hostname, { rootRedirect: "https://old.com" });

      const res = await asAdmin("PUT", `/api/domains/${hostname}`, { rootRedirect: null });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { rootRedirect: string | null } };
      expect(json.data.rootRedirect).toBeNull();
    });

    it("admin can set notFoundRedirect", async () => {
      const hostname = "update-notfound.example.com";
      await createTestDomain(hostname);

      const res = await asAdmin("PUT", `/api/domains/${hostname}`, { notFoundRedirect: "https://404.example.com" });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { notFoundRedirect: string | null } };
      expect(json.data.notFoundRedirect).toBe("https://404.example.com");
    });

    describe("validation", () => {
      const hostname = "put-validation.example.com";

      beforeAll(async () => {
        await createTestDomain(hostname, { accessMode: "all" });
      });

      it.each<[string, unknown, string]>([
        ["no body", undefined, "Invalid JSON body"],
        ["an invalid accessMode", { accessMode: "public" }, 'accessMode must be "all" or "restricted"'],
        ["a non-http redirect URL", { rootRedirect: "ftp://bad.example.com" }, "rootRedirect must be an absolute http or https URL"],
        ["a malformed redirect URL", { rootRedirect: "not-a-url" }, "rootRedirect must be an absolute http or https URL"],
        ["a non-http notFoundRedirect", { notFoundRedirect: "javascript:alert(1)" }, "notFoundRedirect must be an absolute http or https URL"],
      ])("rejects %s with 400", async (_label, body, error) => {
        const res = await asAdmin("PUT", `/api/domains/${hostname}`, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error });
      });
    });
  });

  // -----------------------------------------------------------------------
  // SET ACCESS  PUT /api/domains/:hostname/access
  // -----------------------------------------------------------------------
  describe("PUT /api/domains/:hostname/access", () => {
    it("admin sets access emails, replacing existing ones", async () => {
      const hostname = "set-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, "old@test.com");

      const res = await asAdmin("PUT", `/api/domains/${hostname}/access`, { emails: ["new1@test.com", "new2@test.com"] });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toContain("new1@test.com");
      expect(json.data).toContain("new2@test.com");
      expect(json.data).not.toContain("old@test.com");

      // Read back persisted state — guards against a PUT that only echoes the input
      const getRes = await asAdmin("GET", `/api/domains/${hostname}`);
      const getJson = await getRes.json() as { data: { accessEmails: string[] } };
      expect(getJson.data.accessEmails).toContain("new1@test.com");
      expect(getJson.data.accessEmails).toContain("new2@test.com");
      expect(getJson.data.accessEmails).not.toContain("old@test.com");
    });

    it("admin can clear access by setting empty array", async () => {
      const hostname = "clear-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, "someone@test.com");

      const res = await asAdmin("PUT", `/api/domains/${hostname}/access`, { emails: [] });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toEqual([]);

      // Read back persisted state — the pre-seeded row must actually be deleted, not just
      // absent from the echoed response
      const row = await env.DB.prepare(
        "SELECT email FROM domain_access WHERE hostname = ? AND email = ?"
      ).bind(hostname, "someone@test.com").first();
      expect(row).toBeNull();

      const getRes = await asAdmin("GET", `/api/domains/${hostname}`);
      const getJson = await getRes.json() as { data: { accessEmails: string[] } };
      expect(getJson.data.accessEmails).toEqual([]);
    });

    it("emails are normalized to lowercase", async () => {
      const hostname = "lowercase-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });

      const res = await asAdmin("PUT", `/api/domains/${hostname}/access`, { emails: ["UPPER@Test.COM"] });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toContain("upper@test.com");
    });

    it("stores an email once when it repeats in a different case", async () => {
      const hostname = "dedupe-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });

      const res = await asAdmin("PUT", `/api/domains/${hostname}/access`, {
        emails: ["dup@test.com", "DUP@Test.com", " dup@test.com ", "other@test.com"],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: ["dup@test.com", "other@test.com"] });

      const { results } = await env.DB.prepare("SELECT email FROM domain_access WHERE hostname = ? ORDER BY email")
        .bind(hostname).all<{ email: string }>();
      expect(results.map(r => r.email)).toEqual(["dup@test.com", "other@test.com"]);
    });

    describe("validation", () => {
      const hostname = "access-validation.example.com";

      beforeAll(async () => {
        await createTestDomain(hostname);
      });

      it.each<[string, unknown, string]>([
        ["no body", undefined, "Invalid JSON body"],
        ["a missing emails field", {}, "emails must be an array"],
        ["a non-array emails", { emails: "not-an-array" }, "emails must be an array"],
        ["an invalid email", { emails: ["not-an-email"] }, "Invalid email: not-an-email"],
      ])("rejects %s with 400", async (_label, body, error) => {
        const res = await asAdmin("PUT", `/api/domains/${hostname}/access`, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error });
      });
    });
  });

  // -----------------------------------------------------------------------
  // SYNC  POST /api/domains/sync
  // -----------------------------------------------------------------------
  // Sync deletes every domain_config row Cloudflare does not list, so this block runs last.
  describe("POST /api/domains/sync", () => {
    const sync = () => api("POST", "/api/domains/sync", { headers: adminHeaders, env: { ...adminEnvObj, ...CF_CREDENTIALS } });

    it("removes a dropped domain's links instead of moving them onto the primary host", async () => {
      const removed = "sync-removed.example.com";
      await createTestDomain(removed);
      const owner = await newUser("sync-links");
      const customLink = await createTestLink({
        slug: "sync-collide",
        userId: owner.user.id,
        domainHostname: removed,
      });
      const primaryLink = await createTestLink({
        slug: "sync-collide",
        userId: owner.user.id,
        domainHostname: null,
      });
      await env.KV.put(`${removed}:sync-collide`, JSON.stringify({ url: "https://example.com" }));

      stubCloudflareDomains(["kept.example.com"]);

      const res = await sync();
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
      const owner = await newUser("sync-multi");
      const linkA = await createTestLink({ slug: "sync-multi-a", userId: owner.user.id, domainHostname: removedA });
      const linkB = await createTestLink({ slug: "sync-multi-b", userId: owner.user.id, domainHostname: removedB });
      await env.KV.put(`${removedA}:sync-multi-a`, JSON.stringify({ url: "https://example.com/a" }));
      await env.KV.put(`${removedB}:sync-multi-b`, JSON.stringify({ url: "https://example.com/b" }));

      stubCloudflareDomains(["kept.example.com"]);

      const res = await sync();
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
      const db = getDb(env.DB);
      const now = new Date();
      const [first, ...rest] = removed.map(hostname => db.insert(domainConfig).values({ hostname, updatedAt: now }));
      await db.batch([first, ...rest]);
      const owner = await newUser("sync-many");
      const edges = [removed[0], removed[removed.length - 1]];
      for (const hostname of edges) {
        await createTestLink({ slug: "sync-many", userId: owner.user.id, domainHostname: hostname });
        await env.KV.put(`${hostname}:sync-many`, JSON.stringify({ url: "https://example.com" }));
      }

      stubCloudflareDomains(["kept.example.com"]);

      const res = await sync();
      expect(res.status).toBe(200);
      const hostnames = new Set((await res.json() as { data: { hostname: string }[] }).data.map(d => d.hostname));
      expect(removed.filter(h => hostnames.has(h))).toEqual([]);
      for (const hostname of edges) {
        expect(await env.KV.get(`${hostname}:sync-many`)).toBeNull();
      }
    });

    it("follows every page, asking for the configured Worker's domains", async () => {
      const fetchSpy = stubCloudflareDomains(["page-one.example.com"], ["page-two.example.com"]);

      const res = await sync();
      expect(res.status).toBe(200);
      const hostnames = (await res.json() as { data: { hostname: string }[] }).data.map(d => d.hostname);
      expect(hostnames).toEqual(expect.arrayContaining(["page-one.example.com", "page-two.example.com"]));

      const urls = fetchSpy.mock.calls.map(([input]) => new URL(String(input)));
      expect(urls.map(url => url.searchParams.get("page"))).toEqual(["1", "2"]);
      for (const url of urls) {
        expect(url.searchParams.get("service")).toBe(env.WORKER_NAME);
      }
    });

    it("answers 502 on a non-OK Cloudflare response and changes nothing", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("denied", { status: 403 }));
      await createTestDomain("sync-502-kept.example.com");

      const res = await sync();
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "Cloudflare API error: 403 denied" });
      expect(await env.DB.prepare("SELECT hostname FROM domain_config WHERE hostname = ?")
        .bind("sync-502-kept.example.com").first()).not.toBeNull();
    });

    it("inserts new hostnames and always keeps the primary host", async () => {
      stubCloudflareDomains(["fresh-sync.example.com"]);

      const res = await sync();
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string }[] };
      const hostnames = json.data.map((d) => d.hostname);
      expect(hostnames).toContain("fresh-sync.example.com");
      expect(hostnames).toContain("localhost");
    });
  });
});
