import { env } from "cloudflare:workers";

/** JSON body type used in integration tests. */
export type JsonBody = Record<string, unknown>;

/** Cloudflare.Env extended with secrets that are not in the generated wrangler types. */
type EnvWithSecrets = Cloudflare.Env & { BETTER_AUTH_SECRET?: string };

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
  envBindings: EnvWithSecrets = env,
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
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?)`
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
    domainHostname: string | null;
    expiresAt: number | null;
    maxClicks: number | null;
    password: string | null;
    isInternal: boolean;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    paramForwarding: boolean;
  }> = {}
) {
  const id = overrides.id ?? crypto.randomUUID();
  const userId = overrides.userId ?? "unknown-user";
  const slug = overrides.slug ?? `test-${id.slice(0, 8)}`;
  const destinationUrl = overrides.destinationUrl ?? "https://example.com";
  const redirectType = overrides.redirectType ?? 302;
  const title = overrides.title ?? null;
  const isActive = overrides.isActive !== false;
  const domainHostname = overrides.domainHostname ?? null;
  const expiresAt = overrides.expiresAt ?? null;
  const maxClicks = overrides.maxClicks ?? null;
  const password = overrides.password ?? null;
  const isInternal = overrides.isInternal ? 1 : 0;
  const ogTitle = overrides.ogTitle ?? null;
  const ogDescription = overrides.ogDescription ?? null;
  const ogImage = overrides.ogImage ?? null;
  const paramForwarding = overrides.paramForwarding ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `INSERT INTO links (id, userId, slug, destinationUrl, redirectType, title, createdAt, updatedAt, isActive, domainHostname, expiresAt, maxClicks, password, isInternal, ogTitle, ogDescription, ogImage, paramForwarding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, userId, slug, destinationUrl, redirectType, title, now, now, isActive ? 1 : 0, domainHostname, expiresAt, maxClicks, password, isInternal, ogTitle, ogDescription, ogImage, paramForwarding)
    .run();

  return { id, userId, slug, destinationUrl, redirectType, title, isActive, domainHostname, expiresAt, maxClicks, password, isInternal: !!overrides.isInternal, ogTitle, ogDescription, ogImage, paramForwarding: !!overrides.paramForwarding, createdAt: now, updatedAt: now };
}

/** Insert a domain_config row directly into D1 for test setup. */
export async function createTestDomain(
  db: D1Database = env.DB,
  hostname: string,
  overrides: Partial<{
    rootRedirect: string | null;
    notFoundRedirect: string | null;
    accessMode: string;
  }> = {}
) {
  const rootRedirect = overrides.rootRedirect ?? null;
  const notFoundRedirect = overrides.notFoundRedirect ?? null;
  const accessMode = overrides.accessMode ?? "all";
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `INSERT OR IGNORE INTO domain_config (hostname, rootRedirect, notFoundRedirect, accessMode, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(hostname, rootRedirect, notFoundRedirect, accessMode, now)
    .run();

  return { hostname, rootRedirect, notFoundRedirect, accessMode, updatedAt: now };
}

/** Insert a click stat row directly into D1 for the given link. */
export async function insertClickStat(
  db: D1Database = env.DB,
  linkId: string,
  clicks: number,
  date = "2026-03-17",
  uniqueClicks?: number
) {
  await db
    .prepare(
      "INSERT OR REPLACE INTO link_stats (linkId, date, clicks, uniqueClicks) VALUES (?, ?, ?, ?)"
    )
    .bind(linkId, date, clicks, uniqueClicks ?? clicks)
    .run();
}

/** Make a request to the app. */
export function apiRequest(
  app: any,
  method: string,
  path: string,
  opts: { body?: any; headers?: Record<string, string> } = {}
) {
  const init: any = { method, headers: { ...(opts.headers ?? {}) } };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
  }
  return app.request(path, init, env, mockExecutionCtx());
}

/** Mock execution context for app.request() calls that need waitUntil. */
export function mockExecutionCtx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      // Swallow rejections from background tasks (e.g. FK errors on test-only linkIds)
      p.catch(() => {});
    },
    passThroughOnException: () => {},
    exports: {} as Cloudflare.Exports,
    props: {},
    tracing: {} as Tracing,
  };
}
