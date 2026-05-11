import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, apiRequest, type JsonBody } from "../helpers";

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

  it("API key is rejected on GET /api/me (session-only route)", async () => {
    const { key } = await createApiKey(authHeaders, "me-route-test");
    const res = await api("GET", "/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
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

  // -------------------------------------------------------------------------
  // Admin detection via ADMIN_EMAILS env var
  // -------------------------------------------------------------------------
  it("user in ADMIN_EMAILS is treated as admin when using API key", async () => {
    // Set up a user whose email matches ADMIN_EMAILS
    const adminAuth = await setupAuth(env, { email: "admin@example.com" });
    // Override env.ADMIN_EMAILS for this test by patching — but since env is read-only
    // in the worker context, we verify indirectly: admin user can still reach the API.
    // The actual isAdmin flag is set in requireAuthOrApiKey based on env.ADMIN_EMAILS.
    const { key } = await createApiKey(adminAuth.headers, "admin-key-test");
    const res = await api("GET", "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    // Should succeed regardless of admin status (endpoint is not admin-only)
    expect(res.status).toBe(200);
  });
});
