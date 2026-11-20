import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setupAuth, api, adminEnv, newAdmin, newUser, createTestDomain, createTestLink, fakeLimiter, uniq } from "../helpers";

/** The key's stored lastUsedAt, in epoch seconds. */
async function lastUsedAt(id: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT lastUsedAt FROM api_keys WHERE id = ?").bind(id).first<{ lastUsedAt: number | null }>();
  return row!.lastUsedAt;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** Make one Bearer request to /api/links and wait for its background writes. */
async function useKey(key: string) {
  const ctx = createExecutionContext();
  const res = await api("GET", "/api/links", { headers: bearer(key), ctx });
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
}

/** Create an API key through the API for the session in `authHeaders`. */
async function createApiKey(authHeaders: Record<string, string>, name: string) {
  const res = await api("POST", "/api/keys", { headers: authHeaders, body: { name } });
  expect(res.status).toBe(201);
  const json = await res.json() as { data: { id: string; key: string; prefix: string } };
  return json.data;
}

describe("API key auth (requireAuthOrApiKey)", () => {
  let authHeaders: Record<string, string>;
  let userId: string;
  // Shared by every test that leaves the key's row as it is, which keeps the
  // user under the ten-key cap.
  let key: string;
  let linkId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
    authHeaders = auth.headers;
    userId = auth.user.id;
    key = (await createApiKey(authHeaders, "shared")).key;
    linkId = (await createTestLink({ userId })).id;
  });

  // -------------------------------------------------------------------------
  // Which mounts take a key
  // -------------------------------------------------------------------------
  it.each([
    "/api/me",
    "/api/links",
    "/api/campaigns",
    "/api/stats/:linkId/summary",
    "/api/reports/:linkId",
  ])("accepts a key on GET %s and meters it", async (path) => {
    const res = await api("GET", path.replace(":linkId", linkId), { headers: bearer(key) });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it("accepts a key on POST /api/bulk and creates the links for the key's owner", async () => {
    const slug = uniq("bulk-key");

    const res = await api("POST", "/api/bulk", {
      headers: bearer(key),
      body: { links: [{ slug, destinationUrl: "https://example.com/bulk" }] },
    });

    expect(res.status).toBe(200);
    const { results } = await res.json() as { results: { id: string; slug: string; success: boolean }[] };
    expect(results).toMatchObject([{ slug, success: true }]);
    const row = await env.DB.prepare("SELECT userId FROM links WHERE id = ?").bind(results[0].id).first<{ userId: string }>();
    expect(row?.userId).toBe(userId);
  });

  // A leaked key must not mint keys, touch domains, teams or admin routes.
  it.each(["/api/keys", "/api/domains", "/api/teams", "/api/admin/users"])(
    "rejects a key on session-only GET %s with 401",
    async (path) => {
      const res = await api("GET", path, { headers: bearer(key) });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    },
  );

  it("GET /api/me with a key returns the key owner", async () => {
    const res = await api("GET", "/api/me", { headers: bearer(key) });

    expect(res.status).toBe(200);
    expect((await res.json() as { data: { id: string } }).data.id).toBe(userId);
  });

  // -------------------------------------------------------------------------
  // Expired API key
  // -------------------------------------------------------------------------
  it("expired API key returns 401", async () => {
    const { key: expiring, id } = await createApiKey(authHeaders, "expiry-test-key");
    await env.DB.prepare("UPDATE api_keys SET expiresAt = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) - 3600, id)
      .run();

    const res = await api("GET", "/api/links", { headers: bearer(expiring) });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "API key expired" });
  });

  // -------------------------------------------------------------------------
  // lastUsedAt, written at most once per 5 minutes
  // -------------------------------------------------------------------------
  describe("lastUsedAt", () => {
    // A frozen clock keeps each test's offsets exact against the 5-minute window.
    beforeEach(() => {
      vi.setSystemTime(Date.now());
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is set on the first successful API key request", async () => {
      const { key: fresh, id } = await createApiKey(authHeaders, "lastused-test-key");
      expect(await lastUsedAt(id)).toBeNull();

      await useKey(fresh);

      expect(await lastUsedAt(id)).toBe(Math.floor(Date.now() / 1000));
    });

    it("is not rewritten within 5 minutes of the last write", async () => {
      const { key: recentKey, id } = await createApiKey(authHeaders, "lastused-recent");
      const recent = Math.floor(Date.now() / 1000) - 60;
      await env.DB.prepare("UPDATE api_keys SET lastUsedAt = ? WHERE id = ?").bind(recent, id).run();

      await useKey(recentKey);

      expect(await lastUsedAt(id)).toBe(recent);
    });

    it("is rewritten once it is more than 5 minutes old", async () => {
      const { key: staleKey, id } = await createApiKey(authHeaders, "lastused-stale");
      const stale = Math.floor(Date.now() / 1000) - 6 * 60;
      await env.DB.prepare("UPDATE api_keys SET lastUsedAt = ? WHERE id = ?").bind(stale, id).run();

      await useKey(staleKey);

      expect(await lastUsedAt(id)).toBe(Math.floor(Date.now() / 1000));
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting (the binding is faked per request to control its answer)
  // -------------------------------------------------------------------------
  it("answers 429 with the limit headers when the limiter refuses, keyed on the token prefix", async () => {
    const limiter = fakeLimiter(false);

    const res = await api("GET", "/api/links", {
      headers: bearer(key),
      env: { ...env, API_KEY_RATE_LIMITER: limiter },
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded", retryAfter: 60 });
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: key.slice(0, 16) });
  });

  it("meters a collection-root request once and sets X-RateLimit-Limit", async () => {
    // `/api/links` matches the `/api/links/*` middleware; a second registration
    // for the bare path would run the chain twice and count two requests.
    const limiter = fakeLimiter(true);

    const res = await api("GET", "/api/links", {
      headers: bearer(key),
      env: { ...env, API_KEY_RATE_LIMITER: limiter },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: key.slice(0, 16) });
  });

  it("checks the limit before key verification (429, not 401, for an over-limit unknown key)", async () => {
    const unknown = "veer_neverissuedNotARealKey0000000000000000";
    const limiter = fakeLimiter(false);

    const res = await api("GET", "/api/links", {
      headers: bearer(unknown),
      env: { ...env, API_KEY_RATE_LIMITER: limiter },
    });

    expect(res.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: "veer_neverissued" });
  });

  // -------------------------------------------------------------------------
  // Admin detection via ADMIN_EMAILS env var
  // -------------------------------------------------------------------------
  it("a key owner in ADMIN_EMAILS is admin: bypasses restricted domain access", async () => {
    // isAdmin is computed from the request env's ADMIN_EMAILS on every request.
    const admin = await newAdmin();
    await createTestDomain("admin-apikey-restricted.example.com", { accessMode: "restricted" });
    const { key: adminKey } = await createApiKey(admin.headers, "admin-key-test");

    const res = await api("POST", "/api/links", {
      headers: bearer(adminKey),
      body: {
        slug: "admin-apikey-bypass",
        destinationUrl: "https://example.com/admin",
        domainHostname: "admin-apikey-restricted.example.com",
      },
      env: admin.env,
    });

    expect(res.status).toBe(201);
  });

  it("a key owner NOT in ADMIN_EMAILS is rejected from a restricted domain", async () => {
    const plain = await newUser("nonadmin-apikey");
    await createTestDomain("nonadmin-apikey-restricted.example.com", { accessMode: "restricted" });
    const { key: plainKey } = await createApiKey(plain.headers, "nonadmin-key-test");

    const res = await api("POST", "/api/links", {
      headers: bearer(plainKey),
      body: {
        slug: "nonadmin-apikey-bypass",
        destinationUrl: "https://example.com/nonadmin",
        domainHostname: "nonadmin-apikey-restricted.example.com",
      },
      env: adminEnv("someone-else@example.com"),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("access");
  });

  it("a key owner in ADMIN_EMAILS whose email is unverified is not admin", async () => {
    const unverified = await newAdmin({ emailVerified: false });
    const { key: unverifiedKey } = await createApiKey(unverified.headers, "unverified-admin-key");

    const res = await api("GET", "/api/me", { headers: bearer(unverifiedKey), env: unverified.env });

    expect(res.status).toBe(200);
    expect((await res.json() as { data: { isAdmin: boolean } }).data.isAdmin).toBe(false);
  });
});
