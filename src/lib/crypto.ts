/** HMAC-SHA256 hash an API key using the app secret. Prevents offline brute-force if DB is compromised. */
export async function hashApiKey(key: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(key));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a random API key: `veer_` prefix + 43 random base62 chars (~256 bits entropy). */
export function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const limit = 256 - (256 % chars.length); // 248 — rejection sampling for uniform distribution
  const bytes = new Uint8Array(64);
  let result = "veer_";
  while (result.length < 48) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && result.length < 48) {
        result += chars[b % chars.length];
      }
    }
  }
  return result;
}
