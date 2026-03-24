import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

const RATE_LIMIT = 60;
const WINDOW_SECONDS = 60;

/**
 * KV-based rate limiting middleware for API key requests.
 * Only applies when the request uses Bearer token auth (API keys).
 * Session-authenticated requests pass through unaffected.
 *
 * NOTE: KV does not support atomic increment. Under high concurrency,
 * concurrent requests may read the same counter value and all pass through.
 * This makes the limit advisory, not strict. For strict enforcement,
 * use Cloudflare's native Rate Limiting API binding instead.
 */
export const rateLimitApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  // Only rate-limit API key requests (Bearer token auth)
  if (!authHeader?.startsWith("Bearer ")) {
    await next();
    return;
  }

  // Use first 16 chars of the bearer token as a stable identifier
  const tokenPrefix = authHeader.slice(7, 23);
  const windowEpoch = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const kvKey = `rl:${tokenPrefix}:${windowEpoch}`;

  const stored = await c.env.KV.get(kvKey);
  const count = stored ? parseInt(stored, 10) : 0;

  const secondsRemaining = WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % WINDOW_SECONDS);

  if (count >= RATE_LIMIT) {
    c.header("Retry-After", String(secondsRemaining));
    c.header("X-RateLimit-Limit", String(RATE_LIMIT));
    c.header("X-RateLimit-Remaining", "0");
    return c.json({ error: "Rate limit exceeded", retryAfter: secondsRemaining }, 429);
  }

  // Increment counter. Only set TTL on first write — subsequent writes preserve the window.
  await c.env.KV.put(kvKey, String(count + 1), stored === null ? { expirationTtl: WINDOW_SECONDS * 2 } : {});

  const remaining = RATE_LIMIT - (count + 1);

  // Set headers before next() so they appear even on error responses
  c.header("X-RateLimit-Limit", String(RATE_LIMIT));
  c.header("X-RateLimit-Remaining", String(remaining));

  await next();
});
