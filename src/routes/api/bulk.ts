import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { links } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect } from "../../services/kv-cache";
import { badRequest } from "../../lib/errors";
import { requireTeamMember } from "../../lib/team";
import { validateHttpUrl, validateDomainAccess } from "../../lib/validators";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types";
import type { CachedRedirect } from "../../services/kv-cache";

/** Build a minimal CachedRedirect for a freshly created link (no targets). */
function buildNewLinkCache(
  id: string,
  destinationUrl: string,
  redirectType: number,
  domainHostname: string | null,
): CachedRedirect {
  return {
    url: destinationUrl,
    redirectType,
    linkId: id,
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
    domainHostname,
  };
}

interface BulkLinkInput {
  slug: string;
  destinationUrl: string;
  title?: string;
  redirectType?: number;
  domainHostname?: string;
}

interface ValidatedLink {
  index: number;
  id: string;
  slug: string;
  destinationUrl: string;
  redirectType: number;
  title: string | null;
  domainHostname: string | null;
}

type BulkResult =
  | { slug: string; id: string; success: true }
  | { slug: string; error: string; success: false };

const bulkRoutes = new Hono<AppEnv>();

bulkRoutes.post("/", async (c) => {
  const user = c.var.user!;

  // Check body size — 100KB limit for bulk (allow missing Content-Length per Workers convention)
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > 100_000) {
    throw new HTTPException(413, { message: "Request body too large (max 100KB)" });
  }

  let body: { links: BulkLinkInput[]; teamId?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const teamId = body.teamId?.trim() || null;

  const db = getDb(c.env.DB);

  // Validate team membership if teamId provided
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
  const results: BulkResult[] = new Array(body.links.length);
  const validated: ValidatedLink[] = [];

  // Phase 1: Validate all inputs (format, domain access)
  // Cache domain access checks to avoid repeated queries for the same domain
  const domainAccessCache = new Map<string, boolean>();
  const preValidated: ValidatedLink[] = [];

  for (let i = 0; i < body.links.length; i++) {
    const item = body.links[i];

    // Guard against non-object array items
    if (!item || typeof item !== "object") {
      results[i] = { slug: "", success: false, error: "Invalid link entry" };
      continue;
    }

    const rawSlug = item.slug;
    // Reported back verbatim on failure so the caller can match rows to input;
    // replaced by the canonical form once validation succeeds.
    let slug = rawSlug;

    try {
      const slugCheck = validateSlug(rawSlug);
      if (!slugCheck.valid) {
        results[i] = { slug: rawSlug ?? "", success: false, error: slugCheck.error };
        continue;
      }
      slug = slugCheck.slug;

      try {
        validateHttpUrl(item.destinationUrl, "destinationUrl");
      } catch (e) {
        const msg = e instanceof HTTPException ? e.message : "Invalid destinationUrl";
        results[i] = { slug, success: false, error: msg };
        continue;
      }

      const domainHostname = item.domainHostname || null;

      if (domainHostname) {
        if (!domainAccessCache.has(domainHostname)) {
          try {
            await validateDomainAccess(db, domainHostname, user.email, user.isAdmin);
            domainAccessCache.set(domainHostname, true);
          } catch (e) {
            domainAccessCache.set(domainHostname, false);
            const msg = e instanceof HTTPException ? e.message : "Domain access error";
            results[i] = { slug, success: false, error: msg };
            continue;
          }
        } else if (!domainAccessCache.get(domainHostname)) {
          results[i] = { slug, success: false, error: "You do not have access to this domain" };
          continue;
        }
      }

      preValidated.push({
        index: i,
        id: crypto.randomUUID(),
        slug,
        destinationUrl: item.destinationUrl,
        redirectType: item.redirectType === 301 ? 301 : 302,
        title: item.title || null,
        domainHostname,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unexpected error";
      results[i] = { slug: rawSlug ?? "", success: false, error: msg };
    }
  }

  // Detect intra-batch duplicate slugs before DB check
  const seenInBatch = new Set<string>();
  const deduped: ValidatedLink[] = [];
  for (const v of preValidated) {
    const key = `${v.slug}::${v.domainHostname ?? ""}`;
    if (seenInBatch.has(key)) {
      results[v.index] = { slug: v.slug, success: false, error: "Duplicate slug in batch" };
    } else {
      seenInBatch.add(key);
      deduped.push(v);
    }
  }

  // Batch slug-uniqueness check: single query for all deduped slugs
  if (deduped.length > 0) {
    const allSlugs = deduped.map(v => v.slug);
    const existingSlugs = await db.select({ slug: links.slug, domainHostname: links.domainHostname })
      .from(links)
      .where(inArray(links.slug, allSlugs));

    // Build a set of "slug::domain" keys for O(1) lookup (domain-scoped uniqueness)
    const takenSet = new Set(existingSlugs.map(r => `${r.slug}::${r.domainHostname ?? ""}`));

    for (const v of deduped) {
      const key = `${v.slug}::${v.domainHostname ?? ""}`;
      if (takenSet.has(key)) {
        results[v.index] = { slug: v.slug, success: false, error: "Slug already taken" };
      } else {
        validated.push(v);
      }
    }
  }

  // Phase 2: Batch insert all validated links using db.batch() for atomicity
  if (validated.length > 0) {
    const now = new Date();
    const batchOps = validated.map((v) =>
      db.insert(links).values({
        id: v.id,
        userId: user.id,
        slug: v.slug,
        destinationUrl: v.destinationUrl,
        redirectType: v.redirectType,
        title: v.title,
        expiresAt: null,
        maxClicks: null,
        password: null,
        isInternal: false,
        paramForwarding: false,
        ogTitle: null,
        ogDescription: null,
        ogImage: null,
        domainHostname: v.domainHostname,
        teamId: teamId || null,
        createdAt: now,
        updatedAt: now,
      })
    );

    try {
      await db.batch(batchOps as [typeof batchOps[number], ...typeof batchOps[number][]]);
      // Batch succeeded — mark all as success
      for (const v of validated) {
        results[v.index] = { slug: v.slug, id: v.id, success: true };
      }
    } catch {
      // Batch is atomic — all failed
      for (const v of validated) {
        results[v.index] = { slug: v.slug, success: false, error: "Insert failed (batch rolled back)" };
      }
    }

    // Phase 3: Parallel KV cache writes for successfully inserted links (non-blocking)
    c.executionCtx.waitUntil(Promise.all(
      validated
        .filter((v) => results[v.index]?.success)
        .map((v) => {
          const kvData = buildNewLinkCache(v.id, v.destinationUrl, v.redirectType, v.domainHostname);
          return setCachedRedirect(c.env.KV, v.slug, kvData, v.domainHostname);
        }),
    ));
  }

  return c.json({ results });
});

export default bulkRoutes;
