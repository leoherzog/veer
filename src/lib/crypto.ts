import { generateRandomString } from "better-auth/crypto";

/** HMAC-SHA256 hash an API key using the app secret. Prevents offline brute-force if DB is compromised. */
export async function hashApiKey(key: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(key));
  return new Uint8Array(sig).toHex();
}

/** Generate a random API key: `veer_` prefix + 43 random base62 chars (~256 bits entropy). */
export function generateApiKey(): string {
  return "veer_" + generateRandomString(43, "A-Z", "a-z", "0-9");
}
