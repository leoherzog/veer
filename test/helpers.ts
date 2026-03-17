import { env } from "cloudflare:test";

const TEST_SECRET = "test-secret-minimum-32-characters-long";
let userCounter = 0;

/**
 * Sign a session token the same way Better Auth does:
 * HMAC-SHA256(rawToken, secret) → base64 → "rawToken.signature"
 */
async function signSessionToken(token: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${token}.${base64}`;
}

/**
 * Create a test user + session directly in D1, then sign the session cookie
 * using the same HMAC-SHA256 approach Better Auth uses internally.
 */
export async function setupAuth(
  envBindings: typeof env = env,
  overrides: { email?: string; name?: string } = {}
) {
  userCounter++;
  const id = `test-user-${userCounter}-${Date.now()}`;
  const email = overrides.email ?? `test${userCounter}@example.com`;
  const name = overrides.name ?? "Test User";
  const now = Math.floor(Date.now() / 1000);

  // Insert user
  await envBindings.DB
    .prepare(
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt, role)
       VALUES (?, ?, ?, 0, ?, ?, 'user')`
    )
    .bind(id, name, email, now, now)
    .run();

  // Insert session with a raw token
  const rawToken = `test-token-${id}`;
  const expiresAt = now + 86400;
  await envBindings.DB
    .prepare(
      `INSERT INTO session (id, expiresAt, token, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(`session-${id}`, expiresAt, rawToken, id, now, now)
    .run();

  // Sign the token for the cookie (Better Auth expects: rawToken.hmacSignature)
  const secret = envBindings.BETTER_AUTH_SECRET ?? TEST_SECRET;
  const signedToken = await signSessionToken(rawToken, secret);

  const headers: Record<string, string> = {
    Cookie: `better-auth.session_token=${signedToken}`,
    "Content-Type": "application/json",
  };

  return {
    user: { id, name, email, image: null },
    token: signedToken,
    headers,
  };
}

/** Get headers with a specific signed session token. */
export function authHeaders(signedToken: string): Record<string, string> {
  return {
    Cookie: `better-auth.session_token=${signedToken}`,
    "Content-Type": "application/json",
  };
}

/** Insert a link directly into D1 for test setup. */
export async function createTestLink(
  db: D1Database = env.DB,
  overrides: Partial<{
    id: string;
    userId: string;
    slug: string;
    destinationUrl: string;
    redirectType: number;
    title: string | null;
    isActive: boolean;
  }> = {}
) {
  const id = overrides.id ?? crypto.randomUUID();
  const userId = overrides.userId ?? "unknown-user";
  const slug = overrides.slug ?? `test-${id.slice(0, 8)}`;
  const destinationUrl = overrides.destinationUrl ?? "https://example.com";
  const redirectType = overrides.redirectType ?? 302;
  const title = overrides.title ?? null;
  const isActive = overrides.isActive !== false;
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `INSERT INTO links (id, userId, slug, destinationUrl, redirectType, title, createdAt, updatedAt, isActive)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, userId, slug, destinationUrl, redirectType, title, now, now, isActive ? 1 : 0)
    .run();

  return { id, userId, slug, destinationUrl, redirectType, title, isActive, createdAt: now, updatedAt: now };
}

/** Mock execution context for app.request() calls that need waitUntil. */
export function mockExecutionCtx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      // Swallow rejections from background tasks (e.g. FK errors on test-only linkIds)
      p.catch(() => {});
    },
    passThroughOnException: () => {},
  };
}
