import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { getAuth } from "../../src/auth";
import { setupAuth, api, adminEnv, uniq } from "../helpers";

describe("Auth guards", () => {
  // One row per auth middleware mount; admin routes have their own matrix in admin.test.ts.
  it.each([
    ["GET", "/api/me"],
    ["GET", "/api/links"],
    ["GET", "/api/links/x"],
    ["GET", "/api/stats/x/summary"],
    ["GET", "/api/campaigns"],
    ["GET", "/api/campaigns/x"],
    ["GET", "/api/domains"],
    ["GET", "/api/domains/x"],
    ["GET", "/api/keys"],
    ["DELETE", "/api/keys/x"],
    ["POST", "/api/bulk"],
    ["GET", "/api/reports/x"],
    ["GET", "/api/teams"],
    ["GET", "/api/teams/x"],
  ])("%s %s without a session returns 401", async (method, path) => {
    const res = await api(method, path);

    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBeDefined();
  });

  it("GET /api/me with valid session returns 200 with user data", async () => {
    const auth = await setupAuth();

    const res = await api("GET", "/api/me", { headers: auth.headers });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; email: string } };
    expect(body.data.id).toBe(auth.user.id);
  });
});

describe("Admin detection", () => {
  /** isAdmin as /api/me reports it for a session user whose email is in ADMIN_EMAILS. */
  async function isAdminWith(emailVerified: boolean) {
    const email = `${uniq("admin-verify")}@example.com`;
    const auth = await setupAuth({ email, emailVerified });
    const res = await api("GET", "/api/me", { headers: auth.headers, env: adminEnv(email) });
    expect(res.status).toBe(200);
    return (await res.json() as { data: { isAdmin: boolean } }).data.isAdmin;
  }

  it("a verified user whose email is in ADMIN_EMAILS is admin", async () => {
    expect(await isAdminWith(true)).toBe(true);
  });

  it("an unverified user whose email is in ADMIN_EMAILS is not admin", async () => {
    expect(await isAdminWith(false)).toBe(false);
  });
});

describe("Auth construction", () => {
  it("refuses to build without BETTER_AUTH_SECRET instead of signing with Better Auth's default", () => {
    expect(() => getAuth({ ...env, BETTER_AUTH_SECRET: "" })).toThrow("BETTER_AUTH_SECRET is not set");
  });

  it("answers 500 to an authenticated route when BETTER_AUTH_SECRET is unset", async () => {
    const res = await api("GET", "/api/me", { env: { ...env, BETTER_AUTH_SECRET: "" } });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});

describe("User creation", () => {
  const source = { method: "oauth", oauth: { providerId: "github" } };

  it("refuses a user whose provider did not verify the email", async () => {
    const ctx = await getAuth(env).$context;
    const email = `${uniq("unverified")}@example.com`;

    const created = await ctx.internalAdapter.createUser({ name: "Unverified", email, emailVerified: false }, source);

    // Better Auth turns the null into an `unable_to_create_user` error redirect.
    expect(created).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first()).toBeNull();
  });

  it("creates a user whose provider verified the email", async () => {
    const ctx = await getAuth(env).$context;
    const email = `${uniq("verified")}@example.com`;

    const created = await ctx.internalAdapter.createUser({ name: "Verified", email, emailVerified: true }, source);

    expect(created).toMatchObject({ email, emailVerified: true });
  });
});
