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

/** Validate domain access: checks domain exists in domain_config AND user has access. */
export async function validateDomainAccess(db: Database, hostname: string, userEmail: string, isAdmin: boolean): Promise<void> {
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
