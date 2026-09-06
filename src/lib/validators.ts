import { eq, and } from "drizzle-orm";
import { domainConfig, domainAccess } from "../db/schema";
import { badRequest } from "./errors";
import type { Database } from "../db";

/** Validate that a URL is parseable and uses http(s) scheme. Throws badRequest on failure. */
export function validateHttpUrl(url: string, fieldName: string): void {
  if (!url) throw badRequest(`${fieldName} is required`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`Invalid ${fieldName}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest(`${fieldName} must use http or https`);
  }
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
  primaryHostname: string,
): Promise<void> {
  // The primary host has a domain_config row so it can carry redirects, but a link stored
  // against it would be unreachable: the redirect engine looks up primary-host slugs with
  // domainHostname IS NULL.
  if (hostname.toLowerCase() === primaryHostname) {
    throw badRequest("Links on the primary domain must omit domainHostname");
  }
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
