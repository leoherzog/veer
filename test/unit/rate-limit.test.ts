import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit } from "../../src/services/rate-limit";
import { HTTPException } from "hono/http-exception";

describe("checkRateLimit", () => {
  const kv = env.KV;

  // Use unique key prefixes per test to avoid cross-test interference
  let keyPrefix: string;
  beforeEach(() => {
    keyPrefix = `rate-limit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("allows a single request within the limit", async () => {
    await expect(checkRateLimit(kv, `${keyPrefix}:a`, 5, 60)).resolves.toBeUndefined();
  });

  it("allows requests up to but not exceeding the limit", async () => {
    const key = `${keyPrefix}:b`;
    const limit = 3;
    // Make limit requests — all should succeed
    for (let i = 0; i < limit; i++) {
      await expect(checkRateLimit(kv, key, limit, 60)).resolves.toBeUndefined();
    }
  });

  it("blocks the request when the count equals the limit", async () => {
    const key = `${keyPrefix}:c`;
    const limit = 3;
    // Fill up to the limit
    for (let i = 0; i < limit; i++) {
      await checkRateLimit(kv, key, limit, 60);
    }
    // One more should throw 429
    await expect(checkRateLimit(kv, key, limit, 60)).rejects.toThrow(HTTPException);
  });

  it("throws HTTPException with status 429 when rate limited", async () => {
    const key = `${keyPrefix}:d`;
    const limit = 1;
    await checkRateLimit(kv, key, limit, 60);
    try {
      await checkRateLimit(kv, key, limit, 60);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPException);
      expect((err as HTTPException).status).toBe(429);
    }
  });

  it("uses independent counters for different keys", async () => {
    const keyA = `${keyPrefix}:e1`;
    const keyB = `${keyPrefix}:e2`;
    const limit = 2;

    // Fill keyA to the limit
    await checkRateLimit(kv, keyA, limit, 60);
    await checkRateLimit(kv, keyA, limit, 60);

    // keyB should still be allowed
    await expect(checkRateLimit(kv, keyB, limit, 60)).resolves.toBeUndefined();

    // keyA should now be blocked
    await expect(checkRateLimit(kv, keyA, limit, 60)).rejects.toThrow(HTTPException);
  });

  it("allows a limit of 1 for one request, then blocks the second", async () => {
    const key = `${keyPrefix}:f`;
    await expect(checkRateLimit(kv, key, 1, 60)).resolves.toBeUndefined();
    await expect(checkRateLimit(kv, key, 1, 60)).rejects.toThrow(HTTPException);
  });

  it("resets after TTL expiry (simulated by different key)", async () => {
    // Miniflare does not fast-forward time, so we simulate window expiry
    // by using a fresh key (which represents a new window slot).
    const keyWindow1 = `${keyPrefix}:g-win1`;
    const keyWindow2 = `${keyPrefix}:g-win2`;
    const limit = 1;

    await checkRateLimit(kv, keyWindow1, limit, 60);
    // window1 is now at the limit; window2 (a new window) should be fresh
    await expect(checkRateLimit(kv, keyWindow2, limit, 60)).resolves.toBeUndefined();
  });
});
