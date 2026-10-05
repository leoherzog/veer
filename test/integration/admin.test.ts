import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { setupAuth, createTestLink, createTestTeam, api, adminEnv, newUser, uniq } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An authenticated user plus the env that makes them an admin. */
async function newAdmin() {
  const email = `${uniq("admin")}@example.com`;
  const auth = await setupAuth({ email });
  return { ...auth, env: adminEnv(email) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Admin API", () => {
  describe("authorization", () => {
    const routes: [string, string][] = [
      ["GET", "/api/admin/users"],
      ["PATCH", "/api/admin/users/someone"],
      ["POST", "/api/admin/impersonate/someone"],
      ["POST", "/api/admin/stop-impersonate"],
      ["GET", "/api/admin/teams"],
      ["DELETE", "/api/admin/teams/some-team"],
    ];

    it.each(routes)("returns 403 for a non-admin on %s %s", async (method, path) => {
      const auth = await newUser("plain");
      const res = await api(method, path, { headers: auth.headers, body: method === "GET" ? undefined : {} });
      expect(res.status).toBe(403);
    });

    it.each(routes)("returns 401 without a session on %s %s", async (method, path) => {
      const res = await api(method, path, { body: method === "GET" ? undefined : {} });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/admin/users", () => {
    it("lists users with pagination and link counts", async () => {
      const admin = await newAdmin();
      const target = await newUser("listed");
      await createTestLink({ userId: target.user.id, slug: uniq("adm-user-count") });

      const res = await api("GET", "/api/admin/users?limit=100", { headers: admin.headers, env: admin.env });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { id: string; email: string; maxLinks: number | null; linkCount: number }[];
        pagination: { page: number; limit: number; total: number };
      };
      expect(json.pagination).toMatchObject({ page: 1, limit: 100 });
      expect(json.pagination.total).toBeGreaterThan(0);
      const row = json.data.find(u => u.id === target.user.id);
      expect(row).toBeDefined();
      expect(row!.email).toBe(target.user.email);
      expect(row!.maxLinks).toBeNull();
      // Correlated subqueries must reference the outer column table-qualified, or
      // the subquery's own table shadows the bare name and the count is always 0.
      expect(row!.linkCount).toBe(1);
    });

    it("searches by name", async () => {
      const admin = await newAdmin();
      const name = uniq("Searchable");
      const target = await setupAuth({ email: `${uniq("byname")}@example.com`, name });

      const res = await api(`GET`, `/api/admin/users?q=${encodeURIComponent(name)}`, { headers: admin.headers, env: admin.env });
      const json = await res.json() as { data: { id: string }[] };
      expect(json.data.map(u => u.id)).toEqual([target.user.id]);
    });

    it("treats an underscore in the query as a literal, not a wildcard", async () => {
      const admin = await newAdmin();
      const stem = uniq("under");
      const withUnderscore = await setupAuth({ email: `${stem}_score@example.com` });
      // Differs from the search term only where the underscore sits — a LIKE without
      // the ESCAPE clause would match this too.
      await setupAuth({ email: `${stem}Xscore@example.com` });

      const res = await api("GET", `/api/admin/users?q=${encodeURIComponent(`${stem}_score`)}`, { headers: admin.headers, env: admin.env });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string }[]; pagination: { total: number } };
      expect(json.data.map(u => u.id)).toEqual([withUnderscore.user.id]);
      expect(json.pagination.total).toBe(1);
    });

    it("treats a percent sign in the query as a literal", async () => {
      const admin = await newAdmin();
      const res = await api("GET", "/api/admin/users?q=%25", { headers: admin.headers, env: admin.env });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[] };
      expect(json.data).toHaveLength(0);
    });
  });

  describe("PATCH /api/admin/users/:id", () => {
    it("rejects maxLinks of 0 with 400", async () => {
      const admin = await newAdmin();
      const target = await newUser("quota");

      const res = await api("PATCH", `/api/admin/users/${target.user.id}`, {
        headers: admin.headers, env: admin.env, body: { maxLinks: 0 },
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("maxLinks must be at least 1, or null for unlimited");

      const row = await env.DB.prepare("SELECT maxLinks FROM user WHERE id = ?").bind(target.user.id).first<{ maxLinks: number | null }>();
      expect(row?.maxLinks).toBeNull();
    });

    it("rejects a negative maxLinks with 400", async () => {
      const admin = await newAdmin();
      const target = await newUser("quota");
      const res = await api("PATCH", `/api/admin/users/${target.user.id}`, {
        headers: admin.headers, env: admin.env, body: { maxLinks: -5 },
      });
      expect(res.status).toBe(400);
    });

    it("accepts null as unlimited", async () => {
      const admin = await newAdmin();
      const target = await newUser("quota");
      await api("PATCH", `/api/admin/users/${target.user.id}`, { headers: admin.headers, env: admin.env, body: { maxLinks: 3 } });

      const res = await api("PATCH", `/api/admin/users/${target.user.id}`, {
        headers: admin.headers, env: admin.env, body: { maxLinks: null },
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { data: { maxLinks: number | null } }).data.maxLinks).toBeNull();
    });

    it("returns 404 for an unknown user", async () => {
      const admin = await newAdmin();
      const res = await api("PATCH", "/api/admin/users/no-such-user", { headers: admin.headers, env: admin.env, body: { maxLinks: 5 } });
      expect(res.status).toBe(404);
    });

    it("treats an absent maxLinks as a no-op", async () => {
      const admin = await newAdmin();
      const target = await newUser("quota");
      await api("PATCH", `/api/admin/users/${target.user.id}`, { headers: admin.headers, env: admin.env, body: { maxLinks: 7 } });

      const res = await api("PATCH", `/api/admin/users/${target.user.id}`, { headers: admin.headers, env: admin.env, body: {} });
      expect(res.status).toBe(200);
      expect((await res.json() as { data: { maxLinks: number | null } }).data.maxLinks).toBe(7);

      const missing = await api("PATCH", "/api/admin/users/no-such-user", { headers: admin.headers, env: admin.env, body: {} });
      expect(missing.status).toBe(404);
    });

    it("enforces a positive maxLinks on POST /api/links, and null lifts the cap", async () => {
      const admin = await newAdmin();
      const target = await newUser("capped");

      const patched = await api("PATCH", `/api/admin/users/${target.user.id}`, {
        headers: admin.headers, env: admin.env, body: { maxLinks: 1 },
      });
      expect(patched.status).toBe(200);
      expect((await patched.json() as { data: { maxLinks: number } }).data.maxLinks).toBe(1);

      const first = await api("POST", "/api/links", {
        headers: target.headers, body: { slug: uniq("cap"), destinationUrl: "https://example.com" },
      });
      expect(first.status).toBe(201);

      const second = await api("POST", "/api/links", {
        headers: target.headers, body: { slug: uniq("cap"), destinationUrl: "https://example.com" },
      });
      expect(second.status).toBe(400);
      expect((await second.json() as { error: string }).error).toContain("link limit");

      await api("PATCH", `/api/admin/users/${target.user.id}`, { headers: admin.headers, env: admin.env, body: { maxLinks: null } });
      const third = await api("POST", "/api/links", {
        headers: target.headers, body: { slug: uniq("cap"), destinationUrl: "https://example.com" },
      });
      expect(third.status).toBe(201);
    });
  });

  describe("teams", () => {
    it("lists all teams regardless of membership", async () => {
      const admin = await newAdmin();
      const owner = await newUser("owner");
      const team = await createTestTeam(owner.user.id);
      await createTestLink({ userId: owner.user.id, slug: uniq("adm-team-count"), teamId: team.id });

      const res = await api("GET", "/api/admin/teams?limit=100", { headers: admin.headers, env: admin.env });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; memberCount: number; linkCount: number }[]; pagination: { total: number } };
      const row = json.data.find(t => t.id === team.id);
      expect(row).toBeDefined();
      expect(row!.memberCount).toBe(1);
      expect(row!.linkCount).toBe(1);
    });

    it("deletes any team and nulls its links", async () => {
      const admin = await newAdmin();
      const owner = await newUser("owner");
      const team = await createTestTeam(owner.user.id);
      const link = await createTestLink({ userId: owner.user.id, slug: uniq("adm-team"), teamId: team.id });

      const res = await api("DELETE", `/api/admin/teams/${team.id}`, { headers: admin.headers, env: admin.env });
      expect(res.status).toBe(200);

      expect(await env.DB.prepare("SELECT id FROM teams WHERE id = ?").bind(team.id).first()).toBeNull();

      const row = await env.DB.prepare("SELECT teamId FROM links WHERE id = ?").bind(link.id).first<{ teamId: string | null }>();
      expect(row?.teamId).toBeNull();
    });

    it("returns 404 when deleting an unknown team", async () => {
      const admin = await newAdmin();
      const res = await api("DELETE", "/api/admin/teams/nope", { headers: admin.headers, env: admin.env });
      expect(res.status).toBe(404);
    });
  });

  describe("impersonation", () => {
    // Impersonation is client-side: these endpoints only echo the target and log the event.
    it("echoes the target user without switching the session", async () => {
      const admin = await newAdmin();
      const target = await newUser("target");

      const res = await api("POST", `/api/admin/impersonate/${target.user.id}`, { headers: admin.headers, env: admin.env, body: {} });
      expect(res.status).toBe(200);
      const json = await res.json() as { user: { id: string; email: string }; impersonating: boolean; adminUserId: string };
      expect(json.user.id).toBe(target.user.id);
      expect(json.impersonating).toBe(true);
      expect(json.adminUserId).toBe(admin.user.id);

      // The session still belongs to the admin.
      const me = await api("GET", "/api/me", { headers: admin.headers, env: admin.env });
      expect((await me.json() as { data: { id: string } }).data.id).toBe(admin.user.id);
    });

    it("returns 404 for an unknown target", async () => {
      const admin = await newAdmin();
      const res = await api("POST", "/api/admin/impersonate/no-such-user", { headers: admin.headers, env: admin.env, body: {} });
      expect(res.status).toBe(404);
    });

    it("stop-impersonate returns the authenticated admin, ignoring the body", async () => {
      const admin = await newAdmin();
      const res = await api("POST", "/api/admin/stop-impersonate", {
        headers: admin.headers, env: admin.env, body: { userId: "someone-else" },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { user: { id: string }; impersonating: boolean };
      expect(json.user.id).toBe(admin.user.id);
      expect(json.impersonating).toBe(false);
    });
  });
});
