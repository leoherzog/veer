import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

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
  // A corrupted counter must not disable the limit for the rest of the window.
  const parsed = stored ? parseInt(stored, 10) : 0;
  const count = Number.isFinite(parsed) ? parsed : 0;
  const secondsRemaining = windowSecs - (Math.floor(Date.now() / 1000) % windowSecs);
  return { exceeded: count >= limit, secondsRemaining, count, stored };
}

/** Counter read by `rateLimitApiKeyCheck` and applied by `rateLimitApiKeyIncrement`. */
export interface ApiKeyRateLimitState {
  /** KV key holding the counter for this key and window. */
  kvKey: string;
  /** Counter value read before the request ran. */
  count: number;
  /** Raw stored value, or null when the key is unset (used to gate TTL on first write). */
  stored: string | null;
}

/**
 * Reads the API-key counter, rejects with 429 when the limit is reached, and
 * sets the X-RateLimit-* headers. Register it before `requireAuthOrApiKey`.
 * Session-authenticated requests pass through unaffected.
 */
export const rateLimitApiKeyCheck = createMiddleware<AppEnv>(async (c, next) => {
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

  const { exceeded, secondsRemaining, count, stored } = await checkRateLimit(
    c.env.KV,
    kvKey,
    RATE_LIMIT,
    WINDOW_SECONDS,
  );

  if (exceeded) {
    c.header("Retry-After", String(secondsRemaining));
    c.header("X-RateLimit-Limit", String(RATE_LIMIT));
    c.header("X-RateLimit-Remaining", "0");
    return c.json({ error: "Rate limit exceeded", retryAfter: secondsRemaining }, 429);
  }

  c.set("apiKeyRateLimit", { kvKey, count, stored });

  // Set headers before next() so they appear even on error responses
  c.header("X-RateLimit-Limit", String(RATE_LIMIT));
  c.header("X-RateLimit-Remaining", String(RATE_LIMIT - (count + 1)));

  return next();
});

/**
 * Writes the incremented API-key counter to KV. Register it after
 * `requireAuthOrApiKey` so a rejected key never spends a KV write.
 */
export const rateLimitApiKeyIncrement = createMiddleware<AppEnv>(async (c, next) => {
  const state = c.var.apiKeyRateLimit;
  if (state) {
    // Only set TTL on first write — subsequent writes preserve the window.
    await c.env.KV.put(
      state.kvKey,
      String(state.count + 1),
      state.stored === null ? { expirationTtl: WINDOW_SECONDS * 2 } : {},
    );
  }
  return next();
});
