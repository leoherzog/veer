// PBKDF2-SHA256 hashing for link passwords, stored as `saltHex:hashHex`.
// scripts/seed.ts also runs this module under Node's type stripping, so any
// relative import here needs an explicit `.ts` extension.

// Cloudflare's production runtime rejects PBKDF2 above 100,000 iterations. Local
// workerd has no cap, so no test catches a higher count.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_SALT_LENGTH = 16;

// Hand-written because the Node that runs the seed lacks Uint8Array.prototype.toHex.
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveKey(plain: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    PBKDF2_KEY_LENGTH * 8,
  );
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
  const hash = await deriveKey(plain, salt);
  return `${toHex(salt.buffer)}:${toHex(hash)}`;
}

/** Whether `plain` matches a stored `saltHex:hashHex`. Runs only in workerd, never in the seed. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  const salt = Uint8Array.fromHex(saltHex);
  const expected = Uint8Array.fromHex(hashHex);
  const derived = await deriveKey(plain, salt);
  if (derived.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(new Uint8Array(derived), expected);
}
