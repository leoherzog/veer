import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit } from "../../src/middleware/rate-limit";
import { api, fakeLimiter, setupAuth } from "../helpers";

/** Every KV key name, sorted, to show that a request wrote none. */
async function kvKeyNames(): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names.sort();
}

describe("unmetered traffic", () => {
  // Session traffic is unmetered by design. The request must be authenticated,
  // or requireAuth rejects it before any limiter could run.
  it("session traffic on /api/teams and /api/links never calls the limiter, sets no header and writes no KV key", async () => {
    const { headers } = await setupAuth();
    const limiter = fakeLimiter();
    const before = await kvKeyNames();

    for (const path of ["/api/teams", "/api/links"]) {
      const ctx = createExecutionContext();
      const res = await api("GET", path, { headers, env: { ...env, API_KEY_RATE_LIMITER: limiter }, ctx });
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }

    expect(limiter.limit).not.toHaveBeenCalled();
    expect(await kvKeyNames()).toEqual(before);
    // The file's first full-app request pays the worker's cold start.
  }, 30_000);

  it("a non-Bearer Authorization header goes to session auth unmetered", async () => {
    const { headers } = await setupAuth();
    const limiter = fakeLimiter();

    const res = await api("GET", "/api/links", {
      headers: { ...headers, Authorization: "Basic dXNlcjpwYXNz" },
      env: { ...env, API_KEY_RATE_LIMITER: limiter },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it("demo mode with a Bearer header never calls the limiter and writes no KV key", async () => {
    const limiter = fakeLimiter();
    const before = await kvKeyNames();

    const ctx = createExecutionContext();
    const res = await api("GET", "/api/links", {
      headers: { Authorization: "Bearer veer_demoBearerNeverMetered0000000000000000" },
      env: { ...env, DEMO_MODE: "true", API_KEY_RATE_LIMITER: limiter },
      ctx,
    });
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(limiter.limit).not.toHaveBeenCalled();
    expect(await kvKeyNames()).toEqual(before);
  });
});

describe("API-key limiter binding", () => {
  /** 61 requests with one never-issued key; the limiter counts it before verification. */
  async function burst() {
    const key = `veer_${crypto.randomUUID().replaceAll("-", "")}`;
    const minute = () => Math.floor(Date.now() / 60_000);
    const startMinute = minute();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await api("GET", "/api/links", { headers: { Authorization: `Bearer ${key}` } });
      statuses.push(res.status);
    }
    return { statuses, oneWindow: minute() === startMinute };
  }

  it("answers the 61st request from one key within a minute with 429", async () => {
    // The simulator's windows align to the wall clock. A burst that straddles a
    // rollover is rerun, and the rerun starts just after one.
    let run = await burst();
    if (!run.oneWindow) run = await burst();

    expect(run.oneWindow).toBe(true);
    expect(run.statuses.slice(0, 60)).toEqual(Array(60).fill(401));
    expect(run.statuses[60]).toBe(429);
  }, 60_000);
});

describe("checkRateLimit", () => {
  const WINDOW = 3600;
  /** The KV key checkRateLimit reads for `prefix` in the current window. */
  const windowKey = (prefix: string) => `${prefix}:${Math.floor(Date.now() / 1000 / WINDOW)}`;

  // A frozen clock keeps every read in one window.
  beforeEach(() => {
    vi.setSystemTime(Date.now());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("starts a fresh count in the next window", async () => {
    const prefix = `rl:rollover:${Date.now()}`;
    await env.KV.put(windowKey(prefix), "5", { expirationTtl: 120 });

    vi.setSystemTime(Date.now() + WINDOW * 1000);
    const state = await checkRateLimit(env.KV, prefix, 5, WINDOW);
    expect(state.count).toBe(0);
    expect(state.exceeded).toBe(false);
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
