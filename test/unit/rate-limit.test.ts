import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimitApiKeyCheck, rateLimitApiKeyIncrement, checkRateLimit } from "../../src/middleware/rate-limit";
import { app as veerApp } from "../../src/index";
import { setupAuth } from "../helpers";
import type { AppEnv } from "../../src/types";

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimitApiKeyCheck, rateLimitApiKeyIncrement);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

/** Mirrors the real wiring: the increment sits behind an auth gate that can reject. */
function createRejectingApp() {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimitApiKeyCheck, async () => Response.json({ error: "Unauthorized" }, { status: 401 }), rateLimitApiKeyIncrement);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimitApiKey middleware", () => {
  it("passes through requests without Bearer token", async () => {
    const app = createApp();
    const res = await app.request("/test", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("sets rate limit headers on Bearer token requests", async () => {
    const token = `veer_ratelimit_header_${Date.now()}`;
    const app = createApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(Number(res.headers.get("X-RateLimit-Remaining"))).toBe(59);
  });

  it("decrements remaining count on each request", async () => {
    const token = `veer_ratelimit_decr_${Date.now()}`;
    const app = createApp();

    const res1 = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(Number(res1.headers.get("X-RateLimit-Remaining"))).toBe(59);

    const res2 = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(Number(res2.headers.get("X-RateLimit-Remaining"))).toBe(58);
  });

  it("returns 429 after exceeding the limit", async () => {
    const token = `veer_ratelimit_block_${Date.now()}`;
    const app = createApp();

    // Pre-fill the KV counter to the limit
    const tokenPrefix = token.slice(0, 16);
    const windowEpoch = Math.floor(Date.now() / 1000 / 60);
    const kvKey = `rl:${tokenPrefix}:${windowEpoch}`;
    await env.KV.put(kvKey, "60", { expirationTtl: 120 });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Rate limit exceeded");
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("uses independent counters for different tokens", async () => {
    const tokenA = `veer_rl_AAAA_ind${Date.now()}`;
    const tokenB = `veer_rl_BBBB_ind${Date.now()}`;
    const app = createApp();

    // Pre-fill tokenA to the limit
    const prefixA = tokenA.slice(0, 16);
    const windowEpoch = Math.floor(Date.now() / 1000 / 60);
    await env.KV.put(`rl:${prefixA}:${windowEpoch}`, "60", { expirationTtl: 120 });

    // tokenA should be blocked
    const resA = await app.request("/test", {
      headers: { Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(resA.status).toBe(429);

    // tokenB should still pass
    const resB = await app.request("/test", {
      headers: { Authorization: `Bearer ${tokenB}` },
    }, env);
    expect(resB.status).toBe(200);
  });

  it("does not write the counter when authentication rejects the key", async () => {
    const token = `veer_ratelimit_rej_${Date.now()}`;
    const kvKey = `rl:${token.slice(0, 16)}:${Math.floor(Date.now() / 1000 / 60)}`;
    const app = createRejectingApp();

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(res.status).toBe(401);
    expect(await env.KV.get(kvKey)).toBeNull();
  });

  it("non-Bearer Authorization header passes through unmetered", async () => {
    const app = createApp();
    const res = await app.request("/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });
});

describe("checkRateLimit", () => {
  it("reports zero for an unset key", async () => {
    const state = await checkRateLimit(env.KV, `rl:unset:${Date.now()}`, 60, 60);
    expect(state.count).toBe(0);
    expect(state.stored).toBeNull();
    expect(state.exceeded).toBe(false);
  });

  it("falls back to 0 when the stored counter is not a number", async () => {
    // A corrupted value must not read as NaN — NaN >= limit is false, which
    // would disable the limit for that key until the entry expires.
    const key = `rl:corrupt:${Date.now()}`;
    await env.KV.put(key, "not-a-number", { expirationTtl: 120 });

    const state = await checkRateLimit(env.KV, key, 1, 60);
    expect(state.count).toBe(0);
    expect(state.exceeded).toBe(false);
  });

  it("still enforces the limit for a valid counter", async () => {
    const key = `rl:valid:${Date.now()}`;
    await env.KV.put(key, "5", { expirationTtl: 120 });

    const state = await checkRateLimit(env.KV, key, 5, 60);
    expect(state.count).toBe(5);
    expect(state.exceeded).toBe(true);
  });
});

describe("session-only routes are not rate limited", () => {
  // Session traffic is deliberately unmetered (see AGENTS.md). A session limiter
  // would burn one KV write per request against the free tier's 1,000/day.
  // The request must be AUTHENTICATED to be a real guard: an anonymous request
  // is rejected by requireAuth before any limiter downstream of it would run,
  // so it would pass this test even if a session limiter were reintroduced.
  it("does not meter authenticated requests to /api/teams", async () => {
    const { headers } = await setupAuth(env);

    const res = await veerApp.request("/api/teams", { headers }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
  });

  it("does not meter a burst well past the old 60/min session limit", async () => {
    const { headers } = await setupAuth(env);

    for (let i = 0; i < 65; i++) {
      const res = await veerApp.request("/api/teams", { headers }, env);
      expect(res.status).toBe(200);
    }
    // 65 session lookups exceed the default 5s timeout when the full suite shares the CPU.
  }, 30_000);
});
