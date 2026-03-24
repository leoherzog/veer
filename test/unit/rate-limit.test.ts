import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimitApiKey } from "../../src/middleware/rate-limit";
import type { AppEnv } from "../../src/types";

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimitApiKey);
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
});
