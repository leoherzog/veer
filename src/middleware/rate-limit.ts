/**
 * Fixed-window rate limits backed by KV counters. KV has no atomic increment,
 * so concurrent requests can read the same count and all pass: every limit here
 * is advisory. The Workers Rate Limiting binding is also permissive and counts
 * per Cloudflare location, so it would not make them strict either.
 */
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
  /** Writes the incremented counter. Pass it to `waitUntil` or await it. */
  hit: () => Promise<void>;
}

/**
 * Reads the counter for `{prefix}:{windowEpoch}` and reports whether the limit
 * is reached. The caller sends its own 429 and records the attempt with `hit()`.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  prefix: string,
  limit: number,
  windowSecs: number,
): Promise<RateLimitState> {
  const now = Math.floor(Date.now() / 1000);
  const key = `${prefix}:${Math.floor(now / windowSecs)}`;
  const stored = await kv.get(key);
  // A corrupted counter must not disable the limit for the rest of the window.
  const parsed = stored ? parseInt(stored, 10) : 0;
  const count = Number.isFinite(parsed) ? parsed : 0;
  return {
    exceeded: count >= limit,
    secondsRemaining: windowSecs - (now % windowSecs),
    count,
    // A put without expirationTtl clears the key's expiry, so every write sets it.
    hit: () => kv.put(key, String(count + 1), { expirationTtl: windowSecs * 2 }),
  };
}

/** Password guesses per link and IP on the `POST /:slug` gate. */
export function checkPasswordRateLimit(kv: KVNamespace, linkId: string, ip: string): Promise<RateLimitState> {
  return checkRateLimit(kv, `rl:pw:${linkId}:${ip}`, 5, 900);
}

/**
 * Reads the API-key counter, rejects with 429 when the limit is reached, and
 * sets the X-RateLimit-* headers. Register it before `requireAuthOrApiKey`.
 * Session-authenticated requests pass through unaffected.
 */
export const rateLimitApiKeyCheck = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return next();

  // The first 16 characters of the token identify the key without storing it.
  const rl = await checkRateLimit(c.env.KV, `rl:${authHeader.slice(7, 23)}`, RATE_LIMIT, WINDOW_SECONDS);
  if (rl.exceeded) {
    c.header("Retry-After", String(rl.secondsRemaining));
    c.header("X-RateLimit-Limit", String(RATE_LIMIT));
    c.header("X-RateLimit-Remaining", "0");
    return c.json({ error: "Rate limit exceeded", retryAfter: rl.secondsRemaining }, 429);
  }

  c.set("apiKeyRateLimitHit", rl.hit);

  // Set before next() so the headers survive error responses too.
  c.header("X-RateLimit-Limit", String(RATE_LIMIT));
  c.header("X-RateLimit-Remaining", String(RATE_LIMIT - (rl.count + 1)));

  return next();
});

/**
 * Writes the incremented API-key counter to KV. Register it after
 * `requireAuthOrApiKey` so a rejected key never spends a KV write.
 */
export const rateLimitApiKeyIncrement = createMiddleware<AppEnv>(async (c, next) => {
  await c.var.apiKeyRateLimitHit?.();
  return next();
});
