import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, apiRequest, createTestDomain, mockExecutionCtx, type JsonBody } from "../helpers";

function api(method: string, path: string, opts: { headers?: Record<string, string>; body?: JsonBody } = {}) {
  return apiRequest(app, method, path, opts);
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
    const auth = await setupAuth(env);
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
  // lastUsedAt updated after use
  // -------------------------------------------------------------------------
  it("lastUsedAt gets updated after a successful API key request", async () => {
    const { key, id } = await createApiKey(authHeaders, "lastused-test-key");

    // Confirm lastUsedAt is null before first use
    const before = await env.DB.prepare("SELECT lastUsedAt FROM api_keys WHERE id = ?")
      .bind(id)
      .first() as { lastUsedAt: number | null };
    expect(before.lastUsedAt).toBeNull();

    // Use the key
    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);

    // The update happens in waitUntil — give it a tick to settle
    await new Promise((r) => setTimeout(r, 50));

    const after = await env.DB.prepare("SELECT lastUsedAt FROM api_keys WHERE id = ?")
      .bind(id)
      .first() as { lastUsedAt: number | null };
    expect(after.lastUsedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // No auth at all
  // -------------------------------------------------------------------------
  it("request without any auth returns 401", async () => {
    const res = await api("GET", "/api/links", {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Session auth still works on requireAuthOrApiKey routes
  // -------------------------------------------------------------------------
  it("session cookie auth also works on GET /api/links", async () => {
    const res = await api("GET", "/api/links", { headers: authHeaders });
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // List keys via session auth
  // -------------------------------------------------------------------------
  it("GET /api/keys with session auth returns created keys", async () => {
    const { id } = await createApiKey(authHeaders, "list-test-key");
    const res = await api("GET", "/api/keys", { headers: authHeaders });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { id: string; name: string; prefix: string }[] };
    const found = json.data.find((k) => k.id === id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("list-test-key");
    // The full key is never returned in list, only prefix
    expect(found?.prefix).toMatch(/^veer_/);
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

  it("same API key works on GET /api/links (requireAuthOrApiKey route)", async () => {
    const { key } = await createApiKey(authHeaders, "links-route-verify");
    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Integrated rate limiter test (full stack with real API key)
  // -------------------------------------------------------------------------
  it("rate limits API key after 60 requests", async () => {
    const { key } = await createApiKey(authHeaders, "ratelimit-integration");
    const tokenPrefix = key.slice(0, 16);
    const windowEpoch = Math.floor(Date.now() / 1000 / 60);
    const kvKey = `rl:${tokenPrefix}:${windowEpoch}`;

    // First request should succeed and show rate limit headers
    const res1 = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-RateLimit-Limit")).toBe("60");

    // Pre-seed the KV counter to the limit to trigger 429
    await env.KV.put(kvKey, "60", { expirationTtl: 120 });

    const res61 = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res61.status).toBe(429);
    expect(res61.headers.get("Retry-After")).toBeTruthy();
    expect(res61.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res61.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it("rate limit is checked before key verification (429, not 401, for an over-limit unknown key)", async () => {
    // The limiter keys on the bearer prefix alone, so an over-limit key never
    // reaches the HMAC or the D1 lookup.
    const key = `veer_neverissued${Date.now()}notarealkey00000000000000`;
    const windowEpoch = Math.floor(Date.now() / 1000 / 60);
    await env.KV.put(`rl:${key.slice(0, 16)}:${windowEpoch}`, "60", { expirationTtl: 120 });

    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(429);
  });

  it("an unknown key spends no KV write (the counter is incremented only after auth)", async () => {
    const key = `veer_notawrite${Date.now()}notarealkey00000000000000`;
    const windowEpoch = Math.floor(Date.now() / 1000 / 60);
    const kvKey = `rl:${key.slice(0, 16)}:${windowEpoch}`;

    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
    expect(await env.KV.get(kvKey)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Admin detection via ADMIN_EMAILS env var
  // -------------------------------------------------------------------------
  it("user in ADMIN_EMAILS is treated as admin when using API key: bypasses restricted domain access", async () => {
    // requireAuthOrApiKey computes isAdmin from env.ADMIN_EMAILS on each request, so the
    // env passed to app.request (not the env used to seed the session/key) controls the check.
    const adminEmail = "admin-apikey@example.com";
    const adminEnv = { ...env, ADMIN_EMAILS: adminEmail };
    const adminAuth = await setupAuth(adminEnv, { email: adminEmail });
    await createTestDomain(env.DB, "admin-apikey-restricted.example.com", { accessMode: "restricted" });

    const { key } = await createApiKey(adminAuth.headers, "admin-key-test");
    const res = await app.request(
      "/api/links",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "admin-apikey-bypass",
          destinationUrl: "https://example.com/admin",
          domainHostname: "admin-apikey-restricted.example.com",
        }),
      },
      adminEnv,
      mockExecutionCtx()
    );

    // Admin bypasses the restricted-domain access check (validateDomainAccess short-circuits on isAdmin).
    expect(res.status).toBe(201);
  });

  it("user NOT in ADMIN_EMAILS is rejected from a restricted domain when using API key", async () => {
    const plainEmail = "nonadmin-apikey@example.com";
    const nonAdminEnv = { ...env, ADMIN_EMAILS: "someone-else@example.com" };
    const plainAuth = await setupAuth(nonAdminEnv, { email: plainEmail });
    await createTestDomain(env.DB, "nonadmin-apikey-restricted.example.com", { accessMode: "restricted" });

    const { key } = await createApiKey(plainAuth.headers, "nonadmin-key-test");
    const res = await app.request(
      "/api/links",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "nonadmin-apikey-bypass",
          destinationUrl: "https://example.com/nonadmin",
          domainHostname: "nonadmin-apikey-restricted.example.com",
        }),
      },
      nonAdminEnv,
      mockExecutionCtx()
    );

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("access");
  });
});
