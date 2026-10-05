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

describe("rateLimitApiKey middleware", () => {
  it("passes through requests without Bearer token", async () => {
    const app = createApp();
    const res = await app.request("/test", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("sets the headers and decrements the remaining count on each request", async () => {
    const token = `veer_ratelimit_decr_${Date.now()}`;
    const app = createApp();

    const res1 = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(Number(res1.headers.get("X-RateLimit-Remaining"))).toBe(59);

    const res2 = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect(Number(res2.headers.get("X-RateLimit-Remaining"))).toBe(58);
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
  const WINDOW = 3600;
  /** The KV key checkRateLimit reads for `prefix` in the current window. */
  const windowKey = (prefix: string) => `${prefix}:${Math.floor(Date.now() / 1000 / WINDOW)}`;

  it("reports zero for an unset key", async () => {
    const state = await checkRateLimit(env.KV, `rl:unset:${Date.now()}`, 60, WINDOW);
    expect(state.count).toBe(0);
    expect(state.exceeded).toBe(false);
  });

  it("falls back to 0 when the stored counter is not a number", async () => {
    // A corrupted value must not read as NaN — NaN >= limit is false, which
    // would disable the limit for that key until the entry expires.
    const prefix = `rl:corrupt:${Date.now()}`;
    await env.KV.put(windowKey(prefix), "not-a-number", { expirationTtl: 120 });

    const state = await checkRateLimit(env.KV, prefix, 1, WINDOW);
    expect(state.count).toBe(0);
    expect(state.exceeded).toBe(false);
  });

  it("still enforces the limit for a valid counter", async () => {
    const prefix = `rl:valid:${Date.now()}`;
    await env.KV.put(windowKey(prefix), "5", { expirationTtl: 120 });

    const state = await checkRateLimit(env.KV, prefix, 5, WINDOW);
    expect(state.count).toBe(5);
    expect(state.exceeded).toBe(true);
  });

  it("keeps the counter's expiration on every write, not just the first", async () => {
    const prefix = `rl:ttl:${Date.now()}`;
    await (await checkRateLimit(env.KV, prefix, 60, WINDOW)).hit();
    await (await checkRateLimit(env.KV, prefix, 60, WINDOW)).hit();

    const { keys } = await env.KV.list({ prefix: `${prefix}:` });
    expect(keys).toHaveLength(1);
    expect(await env.KV.get(keys[0].name)).toBe("2");
    expect(keys[0].expiration).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("session-only routes are not rate limited", () => {
  // Session traffic is unmetered: a session limiter would spend one KV write per
  // request against the free tier's 1,000/day. The request must be authenticated,
  // or requireAuth rejects it before any limiter runs and the test passes vacuously.
  it("does not meter authenticated requests to /api/teams", async () => {
    const { headers } = await setupAuth();

    const res = await veerApp.request("/api/teams", { headers }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
  });

  it("does not meter a 65-request authenticated burst", async () => {
    const { headers } = await setupAuth();

    for (let i = 0; i < 65; i++) {
      const res = await veerApp.request("/api/teams", { headers }, env);
      expect(res.status).toBe(200);
    }
    // 65 session lookups exceed the default 5s timeout when the full suite shares the CPU.
  }, 30_000);
});
