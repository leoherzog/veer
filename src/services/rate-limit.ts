import { HTTPException } from "hono/http-exception";

/** Best-effort KV-based rate limiting. Not atomic, but sufficient for abuse prevention. */
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const current = (await kv.get(key, { type: "json" })) as number | null;
  if (current !== null && current >= limit) {
    throw new HTTPException(429, { message: "Too many attempts. Try again later." });
  }
  await kv.put(key, JSON.stringify((current ?? 0) + 1), { expirationTtl: windowSeconds });
}
