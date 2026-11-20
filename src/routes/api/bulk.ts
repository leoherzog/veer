import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { getDb } from "../../db";
import { links } from "../../db/schema";
import { validateSlug } from "../../services/slug";
import { setCachedRedirect, toCachedRedirect } from "../../services/kv-cache";
import { badRequest } from "../../lib/errors";
import { requireTeamMember } from "../../lib/team";
import { validateDomainAccess, getPrimaryHostname, assertLinkQuota, parseLinkCore, type LinkCore } from "../../lib/validators";
import { parseJsonBody } from "../../lib/request";
import { BULK_MAX } from "../../lib/limits";
import type { AuthedEnv } from "../../types";

type BulkResult =
  | { slug: string; id: string; success: true }
  | { slug: string; error: string; success: false };

type NewLink = typeof links.$inferInsert;

/** Uniqueness is per (slug, domain), matching the two unique indexes on links. */
const slugKey = (link: Pick<NewLink, "slug" | "domainHostname">) => `${link.slug}::${link.domainHostname ?? ""}`;

const errorMessage = (e: unknown) => e instanceof HTTPException ? e.message : "Unexpected error";

const bulkRoutes = new Hono<AuthedEnv>();

bulkRoutes.post("/", async (c) => {
  const user = c.var.user;

  const body = await parseJsonBody<{ links: unknown[]; teamId?: string }>(c);

  if (body.teamId !== undefined && body.teamId !== null && typeof body.teamId !== "string") {
    throw badRequest("teamId must be a string");
  }
  const teamId = body.teamId?.trim() || null;

  if (!Array.isArray(body.links)) {
    throw badRequest("links must be an array");
  }

  if (body.links.length === 0) {
    throw badRequest("links array must not be empty");
  }

  if (body.links.length > BULK_MAX) {
    throw badRequest(`Maximum ${BULK_MAX} links per request`);
  }

  const results: BulkResult[] = new Array(body.links.length);
  const primaryHost = getPrimaryHostname(c.env.BETTER_AUTH_URL);

  // Phase 1: validate every item. The format checks need no D1, so they run first.
  const parsed: { index: number; core: LinkCore }[] = [];
  body.links.forEach((item, index) => {
    try {
      parsed.push({ index, core: parseLinkCore(item, primaryHost) });
    } catch (e) {
      // The canonical slug once it validates, as every later error reports it;
      // otherwise the raw input, so the caller can match rows to input.
      const rawSlug = (item as { slug?: unknown } | null)?.slug;
      const input = typeof rawSlug === "string" ? rawSlug : "";
      const slugCheck = validateSlug(input);
      results[index] = { slug: slugCheck.valid ? slugCheck.slug : input, success: false, error: errorMessage(e) };
    }
  });

  const db = getDb(c.env.DB);

  if (teamId) {
    await requireTeamMember(db, teamId, user.id);
  }

  await assertLinkQuota(db, user.id, body.links.length);

  // Cache the domain check per hostname, keeping the message so every item for a
  // rejected domain reports the same reason. null means the domain is usable.
  const domainErrors = new Map<string, string | null>();
  const candidates: { index: number; row: NewLink }[] = [];
  const now = new Date();

  for (const { index, core } of parsed) {
    const hostname = core.domainHostname;
    if (hostname) {
      if (!domainErrors.has(hostname)) {
        try {
          await validateDomainAccess(db, hostname, user.email, user.isAdmin);
          domainErrors.set(hostname, null);
        } catch (e) {
          domainErrors.set(hostname, e instanceof HTTPException ? e.message : "Domain access error");
        }
      }
      const error = domainErrors.get(hostname);
      if (error) {
        results[index] = { slug: core.slug, success: false, error };
        continue;
      }
    }
    candidates.push({
      index,
      row: { ...core, id: crypto.randomUUID(), userId: user.id, teamId, createdAt: now, updatedAt: now },
    });
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

  // Phase 2: insert every validated link in one atomic db.batch().
  if (valid.length > 0) {
    const inserts = valid.map(({ row }) => db.insert(links).values(row).returning());

    let inserted;
    try {
      inserted = await db.batch(inserts as [typeof inserts[number], ...typeof inserts[number][]]);
    } catch (e) {
      console.error(JSON.stringify({
        message: "Bulk insert failed",
        error: e instanceof Error ? e.message : String(e),
        userId: user.id,
        count: valid.length,
      }));
      // db.batch is atomic, so every row failed.
      for (const { index, row } of valid) {
        results[index] = { slug: row.slug, success: false, error: "Insert failed (batch rolled back)" };
      }
      return c.json({ results });
    }

    const rows = inserted.map(([row]) => row);
    rows.forEach((row, i) => {
      results[valid[i].index] = { slug: row.slug, id: row.id, success: true };
    });

    // Phase 3: KV cache writes for the inserted links, off the response path.
    c.executionCtx.waitUntil(Promise.all(
      rows.map(row => setCachedRedirect(c.env.KV, row.slug, toCachedRedirect(row, null), row.domainHostname)),
    ));
  }

  return c.json({ results });
});

export default bulkRoutes;
