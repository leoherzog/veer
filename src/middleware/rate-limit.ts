import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import type { Context } from "hono";

const RATE_LIMIT = 60;
const WINDOW_SECONDS = 60;

export interface RateLimitState {
  /** True when the stored counter has already reached the limit. */
  exceeded: boolean;
  /** Seconds until the current fixed window rolls over. */
  secondsRemaining: number;
  /** Current counter value (0 when the key is unset). */
  count: number;
  /** Raw stored value, or null when the key is unset (used to gate TTL on first write). */
  stored: string | null;
}

/**
 * Standalone advisory rate-limit check for non-middleware callers. Reads the
 * counter, parses it, and reports whether the limit is exceeded plus the
 * seconds left in the window. Callers own their own responses and increments
 * (typically a non-blocking `waitUntil(kv.put(...))`).
 *
 * NOTE: KV does not support atomic increment. Under high concurrency,
 * concurrent requests may read the same counter value and all pass through.
 * This makes the limit advisory, not strict. For strict enforcement,
 * use Cloudflare's native Rate Limiting API binding instead.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSecs: number,
): Promise<RateLimitState> {
  const stored = await kv.get(key);
  const count = stored ? parseInt(stored, 10) : 0;
  const secondsRemaining = windowSecs - (Math.floor(Date.now() / 1000) % windowSecs);
  return { exceeded: count >= limit, secondsRemaining, count, stored };
}

/**
 * Shared KV rate-limit implementation. Reads the counter, checks the limit,
 * increments, sets X-RateLimit-* headers, then calls next().
 */
async function rateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSecs: number,
  c: Context,
  next: () => Promise<void | Response>
): Promise<Response | void> {
  const { exceeded, secondsRemaining, count, stored } = await checkRateLimit(kv, key, limit, windowSecs);

  if (exceeded) {
    c.header("Retry-After", String(secondsRemaining));
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", "0");
    return c.json({ error: "Rate limit exceeded", retryAfter: secondsRemaining }, 429);
  }

  // Increment counter. Only set TTL on first write — subsequent writes preserve the window.
  await kv.put(key, String(count + 1), stored === null ? { expirationTtl: windowSecs * 2 } : {});

  const remaining = limit - (count + 1);
  // Set headers before next() so they appear even on error responses
  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(remaining));

  return next();
}

/**
 * KV-based rate limiting middleware for API key requests.
 * Only applies when the request uses Bearer token auth (API keys).
 * Session-authenticated requests pass through unaffected.
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

  return rateLimit(c.env.KV, kvKey, RATE_LIMIT, WINDOW_SECONDS, c, next);
});
