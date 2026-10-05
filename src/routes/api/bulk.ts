import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { links } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, toCachedRedirect } from "../../services/kv-cache";
import { badRequest } from "../../lib/errors";
import { requireTeamMember } from "../../lib/team";
import {
  validateHttpUrl, validateDomainAccess, getPrimaryHostname, resolveDomainHostname, assertInternalAllowed, assertLinkQuota,
} from "../../lib/validators";
import { parseJsonBody } from "../../lib/request";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types";

interface BulkLinkInput {
  slug: string;
  destinationUrl: string;
  title?: string;
  redirectType?: number;
  domainHostname?: string;
  isInternal?: boolean;
}

type BulkResult =
  | { slug: string; id: string; success: true }
  | { slug: string; error: string; success: false };

type Link = typeof links.$inferSelect;

/** Uniqueness is per (slug, domain), matching the two unique indexes on links. */
const slugKey = (link: Pick<Link, "slug" | "domainHostname">) => `${link.slug}::${link.domainHostname ?? ""}`;

const bulkRoutes = new Hono<AppEnv>();

bulkRoutes.post("/", async (c) => {
  const user = c.var.user!;

  const body = await parseJsonBody<{ links: BulkLinkInput[]; teamId?: string }>(c);

  if (body.teamId !== undefined && body.teamId !== null && typeof body.teamId !== "string") {
    throw badRequest("teamId must be a string");
  }
  const teamId = body.teamId?.trim() || null;

  const db = getDb(c.env.DB);

  if (teamId) {
    await requireTeamMember(db, teamId, user.id);
  }

  if (!Array.isArray(body.links)) {
    throw badRequest("links must be an array");
  }

  if (body.links.length === 0) {
    throw badRequest("links array must not be empty");
  }

  if (body.links.length > 50) {
    throw badRequest("Maximum 50 links per request");
  }

  await assertLinkQuota(db, user.id, body.links.length);

  const results: BulkResult[] = new Array(body.links.length);
  const primaryHost = getPrimaryHostname(c.env.BETTER_AUTH_URL);
  const now = new Date();

  // Phase 1: Validate all inputs (format, domain access)
  // Cache the domain check per hostname, keeping the message so every item for a
  // rejected domain reports the same reason. null means the domain is usable.
  const domainAccessCache = new Map<string, string | null>();
  const candidates: { index: number; row: Link }[] = [];

  for (let i = 0; i < body.links.length; i++) {
    const item = body.links[i];

    if (!item || typeof item !== "object") {
      results[i] = { slug: "", success: false, error: "Invalid link entry" };
      continue;
    }

    // Reported back verbatim on failure so the caller can match rows to input;
    // replaced by the canonical form once validation succeeds.
    let slug = item.slug ?? "";

    try {
      const slugCheck = validateSlug(item.slug);
      if (!slugCheck.valid) throw badRequest(slugCheck.error);
      slug = slugCheck.slug;

      validateHttpUrl(item.destinationUrl, "destinationUrl");
      const domainHostname = resolveDomainHostname(item.domainHostname, primaryHost);
      const isInternal = item.isInternal === true;
      assertInternalAllowed(isInternal, domainHostname);

      if (domainHostname) {
        if (!domainAccessCache.has(domainHostname)) {
          try {
            await validateDomainAccess(db, domainHostname, user.email, user.isAdmin);
            domainAccessCache.set(domainHostname, null);
          } catch (e) {
            domainAccessCache.set(domainHostname, e instanceof HTTPException ? e.message : "Domain access error");
          }
        }
        const domainError = domainAccessCache.get(domainHostname);
        if (domainError) throw badRequest(domainError);
      }

      candidates.push({
        index: i,
        row: {
          id: crypto.randomUUID(),
          userId: user.id,
          slug,
          destinationUrl: item.destinationUrl,
          redirectType: item.redirectType === 301 ? 301 : 302,
          title: item.title || null,
          createdAt: now,
          updatedAt: now,
          isActive: true,
          expiresAt: null,
          maxClicks: null,
          password: null,
          isInternal,
          ogTitle: null,
          ogDescription: null,
          ogImage: null,
          paramForwarding: false,
          domainHostname,
          teamId,
        },
      });
    } catch (e) {
      results[i] = { slug, success: false, error: e instanceof HTTPException ? e.message : "Unexpected error" };
    }
  }

  // One query for every slug already taken on its domain.
  const taken = new Set<string>();
  if (candidates.length > 0) {
    const existing = await db.select({ slug: links.slug, domainHostname: links.domainHostname })
      .from(links)
      .where(inArray(links.slug, candidates.map(({ row }) => row.slug)));
    for (const r of existing) taken.add(slugKey(r));
  }

  // A repeat within the batch is reported as a duplicate; its first occurrence is
  // the one checked against existing links.
  const seen = new Set<string>();
  const valid = candidates.filter(({ index, row }) => {
    const key = slugKey(row);
    const error = seen.has(key) ? "Duplicate slug in batch" : taken.has(key) ? "Slug already taken" : null;
    seen.add(key);
    if (error) results[index] = { slug: row.slug, success: false, error };
    return !error;
  });

  // Phase 2: Batch insert all validated links using db.batch() for atomicity
  if (valid.length > 0) {
    const batchOps = valid.map(({ row }) => db.insert(links).values(row));

    try {
      await db.batch(batchOps as [typeof batchOps[number], ...typeof batchOps[number][]]);
      for (const { index, row } of valid) {
        results[index] = { slug: row.slug, id: row.id, success: true };
      }
    } catch {
      // db.batch is atomic, so every row failed.
      for (const { index, row } of valid) {
        results[index] = { slug: row.slug, success: false, error: "Insert failed (batch rolled back)" };
      }
    }

    // Phase 3: Parallel KV cache writes for successfully inserted links (non-blocking)
    c.executionCtx.waitUntil(Promise.all(
      valid
        .filter(({ index }) => results[index]?.success)
        .map(({ row }) => setCachedRedirect(c.env.KV, row.slug, toCachedRedirect(row, null), row.domainHostname)),
    ));
  }

  return c.json({ results });
});

export default bulkRoutes;
