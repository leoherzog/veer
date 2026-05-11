import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestDomain as sharedCreateTestDomain, mockExecutionCtx, type JsonBody } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Env with ADMIN_EMAILS set so a given email is treated as admin. */
function adminEnv(email: string) {
  return { ...env, ADMIN_EMAILS: email };
}

async function api(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: JsonBody; env?: typeof env } = {}
) {
  const e = opts.env ?? env;
  const init: RequestInit = { method, headers: { ...(opts.headers ?? {}) } };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    (init.headers as Record<string, string>)["Content-Type"] =
      (init.headers as Record<string, string>)["Content-Type"] || "application/json";
  }
  return app.request(path, init, e, mockExecutionCtx());
}

/** Insert a domain_config row directly into D1. */
function createTestDomain(
  hostname: string,
  overrides: Partial<{
    rootRedirect: string | null;
    notFoundRedirect: string | null;
    accessMode: string;
  }> = {}
) {
  return sharedCreateTestDomain(env.DB, hostname, overrides);
}

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
  let adminEmail: string;
  let adminEnvObj: typeof env;

  beforeAll(async () => {
    const userAuth = await setupAuth(env, { email: "domains-user@test.com" });
    userHeaders = userAuth.headers;
    userEmail = userAuth.user.email;

    const adminAuth = await setupAuth(env, { email: "domains-admin@test.com" });
    adminHeaders = adminAuth.headers;
    adminEmail = adminAuth.user.email;
    adminEnvObj = adminEnv(adminEmail);
  });

  // -----------------------------------------------------------------------
  // LIST  GET /api/domains
  // -----------------------------------------------------------------------
  describe("GET /api/domains", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await api("GET", "/api/domains");
      expect(res.status).toBe(401);
    });

    it("admin sees all domains", async () => {
      await createTestDomain("all-visible.example.com");
      await createTestDomain("restricted-visible.example.com", { accessMode: "restricted" });

      const res = await api("GET", "/api/domains", {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string }[] };
      expect(Array.isArray(json.data)).toBe(true);
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

    it("non-admin does not see restricted domain without access", async () => {
      const hostname = "no-access.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });

      const res = await api("GET", "/api/domains", { headers: userHeaders });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { hostname: string }[] };
      const hostnames = json.data.map((d) => d.hostname);
      expect(hostnames).not.toContain(hostname);
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
    it("returns 401 when unauthenticated", async () => {
      const res = await api("GET", "/api/domains/some.example.com");
      expect(res.status).toBe(401);
    });

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
    it("returns 401 when unauthenticated", async () => {
      const res = await api("PUT", "/api/domains/some.example.com", {
        body: { accessMode: "all" },
      });
      expect(res.status).toBe(401);
    });

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
  // ACCESS LIST  GET /api/domains/:hostname/access
  // -----------------------------------------------------------------------
  describe("GET /api/domains/:hostname/access", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await api("GET", "/api/domains/some.example.com/access");
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin user", async () => {
      const hostname = "access-list-forbidden.example.com";
      await createTestDomain(hostname);

      const res = await api("GET", `/api/domains/${hostname}/access`, {
        headers: userHeaders,
      });
      expect(res.status).toBe(403);
    });

    it("admin can list access emails", async () => {
      const hostname = "access-list.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });
      await createDomainAccess(hostname, "alice@test.com");
      await createDomainAccess(hostname, "bob@test.com");

      const res = await api("GET", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toContain("alice@test.com");
      expect(json.data).toContain("bob@test.com");
    });

    it("returns empty array when no access entries exist", async () => {
      const hostname = "access-empty.example.com";
      await createTestDomain(hostname, { accessMode: "restricted" });

      const res = await api("GET", `/api/domains/${hostname}/access`, {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: string[] };
      expect(json.data).toEqual([]);
    });

    it("returns 404 for non-existent domain", async () => {
      const res = await api("GET", "/api/domains/nonexistent.example.com/access", {
        headers: adminHeaders,
        env: adminEnvObj,
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // SET ACCESS  PUT /api/domains/:hostname/access
  // -----------------------------------------------------------------------
  describe("PUT /api/domains/:hostname/access", () => {
    it("returns 401 when unauthenticated", async () => {
      const res = await api("PUT", "/api/domains/some.example.com/access", {
        body: { emails: [] },
      });
      expect(res.status).toBe(401);
    });

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
        body: { emails: "not-an-array" as unknown as string[] },
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
});
