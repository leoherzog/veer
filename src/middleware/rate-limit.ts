/**
 * Rate limits. The API-key and public-report limits use the Workers Rate
 * Limiting binding, which counts per Cloudflare location and is eventually
 * consistent, so both are approximate. The password gate keeps a KV
 * fixed-window counter: its 15-minute window exceeds the binding's longest
 * period of 60 seconds.
 */
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

// The binding does not expose its configuration, so these must match the
// `ratelimits` entries in wrangler.jsonc.
export const API_KEY_LIMIT = 60;
const PUBLIC_REPORT_LIMIT = 30;
const PERIOD_SECONDS = 60;

/**
 * The 429 both binding-backed limiters answer. The binding reports only
 * success, so `Retry-After` is the full period.
 */
export function rateLimited(c: Context<AppEnv>, limit: number) {
  c.header("Retry-After", String(PERIOD_SECONDS));
  c.header("X-RateLimit-Limit", String(limit));
  return c.json({ error: "Rate limit exceeded", retryAfter: PERIOD_SECONDS }, 429);
}

/** Requests per client IP on the unauthenticated public report viewer. */
export const rateLimitPublicReport = createMiddleware<AppEnv>(async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const { success } = await c.env.PUBLIC_REPORT_RATE_LIMITER.limit({ key: ip });
  if (!success) return rateLimited(c, PUBLIC_REPORT_LIMIT);
  await next();
});

interface RateLimitState {
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
 * Reads the KV counter for `{prefix}:{windowEpoch}` and reports whether the
 * limit is reached. KV has no atomic increment, so concurrent requests can read
 * the same count and all pass. The caller sends its own 429 and records the
 * attempt with `hit()`.
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
