import { env } from "cloudflare:workers";
import { app } from "../src/index";
import type { CachedRedirect } from "../src/services/kv-cache";

/** JSON body type used in integration tests. */
export type JsonBody = Record<string, unknown>;

let userCounter = 0;
let seq = 0;

/** Unique identifier fragment for emails, slugs and names. */
export function uniq(prefix: string): string {
  seq++;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/** Env in which the given email is treated as an admin. */
export function adminEnv(email: string): Cloudflare.Env {
  return { ...env, ADMIN_EMAILS: email };
}

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
 * Create a test user + session directly in D1 and return headers carrying the
 * session cookie, signed the way Better Auth signs it.
 */
export async function setupAuth(overrides: { email?: string; name?: string } = {}) {
  userCounter++;
  const id = `test-user-${userCounter}-${Date.now()}`;
  const email = overrides.email ?? `test${userCounter}@example.com`;
  const name = overrides.name ?? "Test User";
  const now = Math.floor(Date.now() / 1000);

  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
    .bind(id, name, email, now, now)
    .run();

  const rawToken = `test-token-${id}`;
  await env.DB
    .prepare(
      `INSERT INTO session (id, expiresAt, token, userId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(`session-${id}`, now + 86400, rawToken, id, now, now)
    .run();

  const headers: Record<string, string> = {
    Cookie: `better-auth.session_token=${await signSessionToken(rawToken, env.BETTER_AUTH_SECRET)}`,
    "Content-Type": "application/json",
  };

  return { user: { id, name, email }, headers };
}

/** A fresh authenticated user with a unique email. */
export function newUser(label = "user") {
  return setupAuth({ email: `${uniq(label)}@example.com` });
}

/** Insert a link directly into D1 for test setup. */
export async function createTestLink(
  fields: { userId: string } & Partial<{
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
    teamId: string | null;
  }>
) {
  const id = crypto.randomUUID();
  const slug = fields.slug ?? `test-${id.slice(0, 8)}`;
  const destinationUrl = fields.destinationUrl ?? "https://example.com";
  const now = Math.floor(Date.now() / 1000);

  await env.DB
    .prepare(
      `INSERT INTO links (id, userId, slug, destinationUrl, redirectType, title, createdAt, updatedAt, isActive, domainHostname, expiresAt, maxClicks, password, isInternal, ogTitle, ogDescription, ogImage, teamId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id, fields.userId, slug, destinationUrl, fields.redirectType ?? 302, fields.title ?? null, now, now,
      fields.isActive === false ? 0 : 1, fields.domainHostname ?? null, fields.expiresAt ?? null,
      fields.maxClicks ?? null, fields.password ?? null, fields.isInternal ? 1 : 0,
      fields.ogTitle ?? null, fields.ogDescription ?? null, fields.ogImage ?? null, fields.teamId ?? null
    )
    .run();

  return { id, slug, destinationUrl };
}

/** Insert a domain_config row directly into D1 for test setup. */
export async function createTestDomain(
  hostname: string,
  overrides: Partial<{
    rootRedirect: string | null;
    notFoundRedirect: string | null;
    accessMode: string;
  }> = {}
) {
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO domain_config (hostname, rootRedirect, notFoundRedirect, accessMode, updatedAt)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      hostname,
      overrides.rootRedirect ?? null,
      overrides.notFoundRedirect ?? null,
      overrides.accessMode ?? "all",
      Math.floor(Date.now() / 1000)
    )
    .run();
}

/** Add a membership row directly, bypassing the invite flow. */
export async function addTestTeamMember(teamId: string, userId: string, role: "admin" | "member" = "member") {
  await env.DB
    .prepare("INSERT OR REPLACE INTO team_members (teamId, userId, role, joinedAt) VALUES (?, ?, ?, ?)")
    .bind(teamId, userId, role, Math.floor(Date.now() / 1000))
    .run();
}

/** Insert a team directly into D1 with the given user as its only member. */
export async function createTestTeam(userId: string, role: "admin" | "member" = "admin") {
  const id = crypto.randomUUID();
  const name = `Team ${id.slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO teams (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
    .bind(id, name, now, now)
    .run();
  await addTestTeamMember(id, userId, role);
  return { id, name };
}

/** Insert a click stat row directly into D1 for the given link. */
export async function insertClickStat(linkId: string, clicks: number, date: string) {
  await env.DB
    .prepare("INSERT OR REPLACE INTO link_stats (linkId, date, clicks) VALUES (?, ?, ?)")
    .bind(linkId, date, clicks)
    .run();
}

/** UTC date `n` days before today as YYYY-MM-DD, the link_stats.date format. */
export function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon D" (UTC) label for a YYYY-MM-DD date, kept independent of the route's formatDate. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A KV cache entry for an active, unprotected 302 link; override as needed. */
export function cachedRedirect(overrides: Partial<CachedRedirect> = {}): CachedRedirect {
  return {
    url: "https://default.example.com",
    redirectType: 302,
    linkId: `link-${crypto.randomUUID().slice(0, 8)}`,
    isActive: true,
    expiresAt: null,
    maxClicks: null,
    hasPassword: false,
    isInternal: false,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    paramForwarding: false,
    targets: null,
    ...overrides,
  };
}

/** A request to the app with `request.cf` set, for app.fetch. */
export function cfRequest(
  path: string,
  { headers, cf }: { headers?: Record<string, string>; cf?: Record<string, unknown> } = {}
): Request {
  return new Request(`http://localhost${path}`, { headers, cf });
}

/** Request the app, JSON-encoding `body`, against the test env unless overridden. */
export function api(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; env?: Cloudflare.Env; ctx?: ExecutionContext } = {}
) {
  const headers: Record<string, string> = { ...opts.headers };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["Content-Type"] ||= "application/json";
  }
  return app.request(path, init, opts.env ?? env, opts.ctx ?? mockExecutionCtx());
}

/** POST /api/links with the given headers. */
export function postLink(body: JsonBody, headers: Record<string, string>) {
  return api("POST", "/api/links", { headers, body });
}

/**
 * Execution context whose waitUntil swallows rejections, such as FK errors on test-only linkIds.
 * A test that asserts on a background write uses cloudflare:test's createExecutionContext instead.
 */
export function mockExecutionCtx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    passThroughOnException: () => {},
    exports: {} as Cloudflare.Exports,
    props: {},
    tracing: {} as Tracing,
    abort: () => {},
  };
}
