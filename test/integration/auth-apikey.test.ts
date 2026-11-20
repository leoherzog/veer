import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { setupAuth, api, adminEnv, createTestDomain, fakeLimiter, type JsonBody } from "../helpers";

/** The key's stored lastUsedAt, in epoch seconds. */
async function lastUsedAt(id: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT lastUsedAt FROM api_keys WHERE id = ?").bind(id).first<{ lastUsedAt: number | null }>();
  return row!.lastUsedAt;
}

/** Make one Bearer request to /api/links and wait for its background writes. */
async function useKey(key: string) {
  const ctx = createExecutionContext();
  const res = await api("GET", "/api/links", { headers: { Authorization: `Bearer ${key}` }, ctx });
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
}

/** Create an API key via the API, returns { id, key, prefix }. */
async function createApiKey(
  authHeaders: Record<string, string>,
  name = "test-key",
  expiresAt?: string
) {
  const body: JsonBody = { name };
  if (expiresAt) body.expiresAt = expiresAt;
  const res = await api("POST", "/api/keys", { headers: authHeaders, body });
  expect(res.status).toBe(201);
  const json = await res.json() as { data: { id: string; key: string; prefix: string } };
  return json.data;
}

describe("API key auth (requireAuthOrApiKey)", () => {
  let authHeaders: Record<string, string>;
  let userId: string;

  beforeAll(async () => {
    const auth = await setupAuth();
    authHeaders = auth.headers;
    userId = auth.user.id;
  });

  // -------------------------------------------------------------------------
  // Valid API key
  // -------------------------------------------------------------------------
  it("valid API key on GET /api/links returns 200", async () => {
    const { key } = await createApiKey(authHeaders, "valid-key-test");
    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Invalid API key
  // -------------------------------------------------------------------------
  it("invalid API key returns 401", async () => {
    const res = await api("GET", "/api/links", {
      headers: { Authorization: "Bearer veer_totallyinvalidkey1234567890123456789012" },
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Expired API key
  // -------------------------------------------------------------------------
  it("expired API key returns 401", async () => {
    const { key, id } = await createApiKey(authHeaders, "expiry-test-key");

    // Manually set expiresAt to the past
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    await env.DB.prepare("UPDATE api_keys SET expiresAt = ? WHERE id = ?")
      .bind(pastTimestamp, id)
      .run();

    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // lastUsedAt, written at most once per 5 minutes
  // -------------------------------------------------------------------------
  it("lastUsedAt gets set on the first successful API key request", async () => {
    const { key, id } = await createApiKey(authHeaders, "lastused-test-key");
    expect(await lastUsedAt(id)).toBeNull();

    await useKey(key);

    expect(await lastUsedAt(id)).not.toBeNull();
  });

  it("lastUsedAt is not rewritten within 5 minutes of the last write", async () => {
    const { key, id } = await createApiKey(authHeaders, "lastused-recent");
    const recent = Math.floor(Date.now() / 1000) - 60;
    await env.DB.prepare("UPDATE api_keys SET lastUsedAt = ? WHERE id = ?").bind(recent, id).run();

    await useKey(key);

    expect(await lastUsedAt(id)).toBe(recent);
  });

  it("lastUsedAt is rewritten once it is more than 5 minutes old", async () => {
    const { key, id } = await createApiKey(authHeaders, "lastused-stale");
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    await env.DB.prepare("UPDATE api_keys SET lastUsedAt = ? WHERE id = ?").bind(stale, id).run();

    await useKey(key);

    expect(await lastUsedAt(id)).toBeGreaterThan(stale);
  });

  // -------------------------------------------------------------------------
  // API key rejected on session-only routes (requireAuth, not requireAuthOrApiKey)
  // -------------------------------------------------------------------------
  it("API key is rejected on GET /api/keys (session-only route)", async () => {
    const { key } = await createApiKey(authHeaders, "keys-route-test");
    const res = await api("GET", "/api/keys", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });

  it("API key is rejected on GET /api/domains (session-only route)", async () => {
    const { key } = await createApiKey(authHeaders, "domains-route-test");
    const res = await api("GET", "/api/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/me works with an API key and returns the key owner", async () => {
    const { key } = await createApiKey(authHeaders, "me-route-test");
    const res = await api("GET", "/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: Record<string, unknown> };
    expect(json.data.id).toBe(userId);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it("GET /api/me exposes only the AuthUser fields, never the raw Better Auth user", async () => {
    const res = await api("GET", "/api/me", { headers: authHeaders });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: Record<string, unknown> };
    expect(Object.keys(json.data).sort()).toEqual(["email", "id", "image", "isAdmin", "name"]);
  });

  // -------------------------------------------------------------------------
  // Rate limiting (the binding is faked per request to control its answer)
  // -------------------------------------------------------------------------
  it("answers 429 with the limit headers when the limiter refuses, keyed on the token prefix", async () => {
    const { key } = await createApiKey(authHeaders, "ratelimit-refused");
    const limiter = fakeLimiter(false);

    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
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
    const { key } = await createApiKey(authHeaders, "ratelimit-once");
    const limiter = fakeLimiter(true);

    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
      env: { ...env, API_KEY_RATE_LIMITER: limiter },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: key.slice(0, 16) });
  });

  it("checks the limit before key verification (429, not 401, for an over-limit unknown key)", async () => {
    const key = `veer_neverissued${Date.now()}notarealkey00000000000000`;
    const limiter = fakeLimiter(false);

    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
      env: { ...env, API_KEY_RATE_LIMITER: limiter },
    });

    expect(res.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({ key: key.slice(0, 16) });
  });

  // -------------------------------------------------------------------------
  // Admin detection via ADMIN_EMAILS env var
  // -------------------------------------------------------------------------
  it("user in ADMIN_EMAILS is treated as admin when using API key: bypasses restricted domain access", async () => {
    // requireAuthOrApiKey computes isAdmin from env.ADMIN_EMAILS on each request, so the
    // request env controls the check.
    const adminEmail = "admin-apikey@example.com";
    const adminAuth = await setupAuth({ email: adminEmail });
    await createTestDomain("admin-apikey-restricted.example.com", { accessMode: "restricted" });

    const { key } = await createApiKey(adminAuth.headers, "admin-key-test");
    const res = await api("POST", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
      body: {
        slug: "admin-apikey-bypass",
        destinationUrl: "https://example.com/admin",
        domainHostname: "admin-apikey-restricted.example.com",
      },
      env: adminEnv(adminEmail),
    });

    // Admin bypasses the restricted-domain access check (validateDomainAccess short-circuits on isAdmin).
    expect(res.status).toBe(201);
  });

  it("user NOT in ADMIN_EMAILS is rejected from a restricted domain when using API key", async () => {
    const plainAuth = await setupAuth({ email: "nonadmin-apikey@example.com" });
    await createTestDomain("nonadmin-apikey-restricted.example.com", { accessMode: "restricted" });

    const { key } = await createApiKey(plainAuth.headers, "nonadmin-key-test");
    const res = await api("POST", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
      body: {
        slug: "nonadmin-apikey-bypass",
        destinationUrl: "https://example.com/nonadmin",
        domainHostname: "nonadmin-apikey-restricted.example.com",
      },
      env: adminEnv("someone-else@example.com"),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("access");
  });

  it("a key owner in ADMIN_EMAILS whose email is unverified is not admin", async () => {
    const email = "unverified-admin-apikey@example.com";
    const unverified = await setupAuth({ email, emailVerified: false });
    const { key } = await createApiKey(unverified.headers, "unverified-admin-key");

    const res = await api("GET", "/api/me", { headers: { Authorization: `Bearer ${key}` }, env: adminEnv(email) });

    expect(res.status).toBe(200);
    expect((await res.json() as { data: { isAdmin: boolean } }).data.isAdmin).toBe(false);
  });
});
