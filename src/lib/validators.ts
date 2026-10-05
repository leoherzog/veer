import { eq, and } from "drizzle-orm";
import { domainConfig, domainAccess, links, user } from "../db/schema";
import { badRequest } from "./errors";
import type { Database } from "../db";

/** True for an absolute http(s) URL. */
export function isHttpUrl(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

/** Validate that a URL is an absolute http(s) URL. Throws badRequest on failure. */
export function validateHttpUrl(url: string, fieldName: string): void {
  if (!url) throw badRequest(`${fieldName} is required`);
  if (!isHttpUrl(url)) throw badRequest(`${fieldName} must be an absolute http or https URL`);
}

/** An optional http(s) URL field: undefined, null and "" mean none. */
export function parseOptionalHttpUrl(raw: unknown, fieldName: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw badRequest(`${fieldName} must be a string`);
  validateHttpUrl(raw, fieldName);
  return raw;
}

/** A required display name of at most 200 characters. Returns it trimmed. */
export function parseName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw badRequest("name is required");
  if (name.length > 200) throw badRequest("name must be 200 characters or fewer");
  return name;
}

/** A future expiry as an ISO string or epoch number; a number below 1e12 is read as seconds. */
export function parseExpiresAt(value: string | number): Date {
  const d = typeof value === "number"
    ? new Date(value < 1e12 ? value * 1000 : value)
    : new Date(value);
  if (isNaN(d.getTime())) throw badRequest("Invalid expiresAt date");
  if (d.getTime() <= Date.now()) throw badRequest("expiresAt must be in the future");
  return d;
}

/** Hostname of BETTER_AUTH_URL, lowercased — the host whose links are stored with domainHostname NULL. */
export function getPrimaryHostname(betterAuthUrl: string): string {
  return new URL(betterAuthUrl).hostname.toLowerCase();
}

/**
 * Normalize a request-supplied domainHostname to what belongs in links.domainHostname.
 * The primary host collapses to null, since its links are keyed by bare slug.
 */
export function resolveDomainHostname(raw: unknown, primaryHostname: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw badRequest("domainHostname must be a string");
  const hostname = raw.trim().toLowerCase();
  if (!hostname) return null;
  return hostname === primaryHostname ? null : hostname;
}

/** Validate domain access: checks domain exists in domain_config AND user has access. */
export async function validateDomainAccess(
  db: Database,
  hostname: string,
  userEmail: string,
  isAdmin: boolean,
): Promise<void> {
  const domain = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!domain) throw badRequest("Domain not found");
  if (isAdmin) return;
  if (domain.accessMode === "all") return;
  // Restricted mode: check domain_access table
  const access = await db.select().from(domainAccess)
    .where(and(eq(domainAccess.hostname, hostname), eq(domainAccess.email, userEmail.toLowerCase())))
    .get();
  if (!access) throw badRequest("You do not have access to this domain");
}

/** A session cookie is host-only to the primary host, so an internal link on a custom domain always 403s. */
export function assertInternalAllowed(isInternal: boolean, domainHostname: string | null): void {
  if (isInternal && domainHostname) throw badRequest("Internal links are only supported on the default domain");
}

/**
 * Reject a create of `adding` links that would exceed the user's maxLinks quota.
 * Soft cap: the count and the insert are separate statements. Team links count
 * against the creator.
 */
export async function assertLinkQuota(db: Database, userId: string, adding: number): Promise<void> {
  const quota = await db.select({
    maxLinks: user.maxLinks,
    linkCount: db.$count(links, eq(links.userId, userId)),
  }).from(user).where(eq(user.id, userId)).get();
  if (quota?.maxLinks != null && quota.linkCount + adding > quota.maxLinks) {
    throw badRequest(`You have reached your link limit (${quota.maxLinks})`);
  }
}
