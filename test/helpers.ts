// Shared test helpers: requests against the app, and fixtures inserted through
// Drizzle into the pool's D1, so schema defaults apply and a renamed column
// fails the typecheck. None takes a db or env argument.
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, vi, type Mock } from "vitest";
import { makeSignature } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { app } from "../src/index";
import { getDb } from "../src/db";
import { domainAccess, domainConfig, links, linkStats, session, teamMembers, teams, user } from "../src/db/schema";
import { DEMO_USER } from "../src/lib/demo";
import type { CachedRedirect } from "../src/services/kv-cache";

/** JSON body type used in integration tests. */
export type JsonBody = Record<string, unknown>;

let userCounter = 0;
let seq = 0;

/** Unique identifier fragment for emails, slugs and names. Storage is per test file, so a counter suffices. */
export function uniq(prefix: string): string {
  seq++;
  return `${prefix}-${seq}`;
}

/** Env in which the given email is treated as an admin. */
export function adminEnv(email: string): Cloudflare.Env {
  return { ...env, ADMIN_EMAILS: email };
}

/** The pool env with demo mode on. */
export const demoEnv: Cloudflare.Env = { ...env, DEMO_MODE: "true" };

/**
 * Create a user and session in D1 and return headers carrying the session
 * cookie, signed as Better Auth signs it. The email defaults to verified and
 * must be unique, since `user.email` is.
 */
export async function setupAuth(overrides: Partial<typeof user.$inferInsert> = {}) {
  userCounter++;
  const now = new Date();
  // `??` rather than spread order, so an override passed as undefined keeps its default.
  const row = {
    ...overrides,
    id: overrides.id ?? `test-user-${userCounter}`,
    name: overrides.name ?? "Test User",
    emailVerified: overrides.emailVerified ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
  const email = row.email ?? `${row.id}@example.com`;
  const db = getDb(env.DB);
  await db.insert(user).values({ ...row, email });

  const rawToken = `test-token-${row.id}`;
  await db.insert(session).values({
    id: `session-${row.id}`,
    expiresAt: new Date(now.getTime() + 86_400_000),
    token: rawToken,
    userId: row.id,
    createdAt: now,
    updatedAt: now,
  });

  const headers: Record<string, string> = {
    Cookie: `better-auth.session_token=${rawToken}.${await makeSignature(rawToken, env.BETTER_AUTH_SECRET)}`,
    "Content-Type": "application/json",
  };

  return { user: { id: row.id, name: row.name, email }, headers };
}

/** A fresh authenticated user with a unique email. */
export function newUser(label = "user") {
  return setupAuth({ email: `${uniq(label)}@example.com` });
}

/** A fresh authenticated user plus the env that lists their email in ADMIN_EMAILS. */
export async function newAdmin(overrides: Partial<typeof user.$inferInsert> = {}) {
  const auth = await setupAuth({ email: `${uniq("admin")}@example.com`, ...overrides });
  return { ...auth, env: adminEnv(auth.user.email) };
}

/** Insert the user row DEMO_USER stands for, which links owned by the demo user need for their FK. */
export async function createDemoUser() {
  const now = new Date();
  await getDb(env.DB).insert(user).values({
    id: DEMO_USER.id,
    name: DEMO_USER.name,
    email: DEMO_USER.email,
    image: DEMO_USER.image,
    createdAt: now,
    updatedAt: now,
  });
}

/** Insert a link for test setup. The slug defaults to one derived from the id. */
export async function createTestLink(fields: { userId: string } & Partial<typeof links.$inferInsert>) {
  const now = new Date();
  const id = fields.id ?? crypto.randomUUID();
  const row = {
    ...fields,
    id,
    slug: fields.slug ?? `test-${id.slice(0, 8)}`,
    destinationUrl: fields.destinationUrl ?? "https://example.com",
    createdAt: fields.createdAt ?? now,
    updatedAt: fields.updatedAt ?? now,
  };
  await getDb(env.DB).insert(links).values(row);
  return { id: row.id, slug: row.slug, destinationUrl: row.destinationUrl };
}

/** Insert a domain_config row; a hostname that already has one is left as it is. */
export async function createTestDomain(hostname: string, overrides: Partial<typeof domainConfig.$inferInsert> = {}) {
  await getDb(env.DB).insert(domainConfig)
    .values({ hostname, updatedAt: new Date(), ...overrides })
    .onConflictDoNothing();
}

/** Grant an email access to a restricted domain. The email is stored lowercased, as the routes store it. */
export async function createDomainAccess(hostname: string, email: string) {
  await getDb(env.DB).insert(domainAccess)
    .values({ hostname, email: email.toLowerCase() })
    .onConflictDoNothing();
}

/** Add or update a membership row, bypassing the invite flow. */
export async function addTestTeamMember(teamId: string, userId: string, role: "admin" | "member" = "member") {
  await getDb(env.DB).insert(teamMembers)
    .values({ teamId, userId, role, joinedAt: new Date() })
    .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { role } });
}

/** Delete a membership row, ending the user's access to the team's links. */
export async function removeTestTeamMember(teamId: string, userId: string) {
  await getDb(env.DB).delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
}

/** Insert a team with the given user as its only member. */
export async function createTestTeam(userId: string, role: "admin" | "member" = "admin") {
  const id = crypto.randomUUID();
  const name = `Team ${id.slice(0, 8)}`;
  const now = new Date();
  await getDb(env.DB).insert(teams).values({ id, name, createdAt: now, updatedAt: now });
  await addTestTeamMember(id, userId, role);
  return { id, name };
}

/**
 * A team whose admin owns one link, with `memberId` as a plain member, so the
 * member reaches the link only through the team.
 */
export async function createTeamLink(memberId: string) {
  const owner = await setupAuth();
  const team = await createTestTeam(owner.user.id);
  await addTestTeamMember(team.id, memberId);
  const link = await createTestLink({ userId: owner.user.id, teamId: team.id });
  return { team, link };
}

/** Set a link's click count for one YYYY-MM-DD date. */
export async function insertClickStat(linkId: string, clicks: number, date: string) {
  await getDb(env.DB).insert(linkStats)
    .values({ linkId, date, clicks })
    .onConflictDoUpdate({ target: [linkStats.linkId, linkStats.date], set: { clicks } });
}

/** A link's click count summed over every link_stats row, so no test-side date can miss the day the route wrote. */
export async function totalClicks(linkId: string): Promise<number> {
  const row = await getDb(env.DB)
    .select({ clicks: sql<number>`coalesce(sum(${linkStats.clicks}), 0)` })
    .from(linkStats)
    .where(eq(linkStats.linkId, linkId))
    .get();
  return row?.clicks ?? 0;
}

/** Assert the response is the SPA shell from ASSETS, which a 500 or a redirect would fail. */
export async function expectSpaShell(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("Location")).toBeNull();
  expect(await res.text()).toContain('src="/dist/app.js"');
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

/** A KV cache entry for an unprotected 302 link; override as needed. */
export function cachedRedirect(overrides: Partial<CachedRedirect> = {}): CachedRedirect {
  return {
    url: "https://default.example.com",
    redirectType: 302,
    linkId: `link-${crypto.randomUUID().slice(0, 8)}`,
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

/**
 * Request the app against the test env unless overridden. A string or
 * URLSearchParams body is sent as is; any other body is JSON-encoded. `cf`
 * becomes `request.cf`.
 */
export function api(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    env?: Cloudflare.Env;
    ctx?: ExecutionContext;
    cf?: Record<string, unknown>;
  } = {}
) {
  const headers: Record<string, string> = { ...opts.headers };
  const init: RequestInit = { method, headers };
  if (typeof opts.body === "string" || opts.body instanceof URLSearchParams) {
    init.body = opts.body;
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["Content-Type"] ||= "application/json";
  }
  if (opts.cf) init.cf = opts.cf;
  return app.request(path, init, opts.env ?? env, opts.ctx ?? mockExecutionCtx());
}

/** POST /api/links with the given headers. */
export function postLink(body: JsonBody, headers: Record<string, string>) {
  return api("POST", "/api/links", { headers, body });
}

/**
 * A Rate Limiting binding that records its calls and answers `success`. Pass it
 * through the per-request env, since the pool's real binding cannot be steered.
 */
export function fakeLimiter(success = true): { limit: Mock<(options: RateLimitOptions) => Promise<RateLimitOutcome>> } {
  return { limit: vi.fn(async (_options: RateLimitOptions) => ({ success })) };
}

/**
 * Execution context whose waitUntil swallows rejections, such as FK errors on test-only linkIds.
 * A test that asserts on a background write uses cloudflare:test's createExecutionContext instead.
 */
export function mockExecutionCtx(): ExecutionContext {
  const ctx = createExecutionContext();
  const waitUntil = ctx.waitUntil.bind(ctx);
  ctx.waitUntil = (promise) => waitUntil(promise.catch(() => {}));
  return ctx;
}
