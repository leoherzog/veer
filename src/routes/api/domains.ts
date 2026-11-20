import { Hono } from "hono";
import { eq, inArray, or } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../db";
import { domainConfig, domainAccess, links } from "../../db/schema";
import { deleteCachedRedirect } from "../../services/kv-cache";
import { HTTPException } from "hono/http-exception";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { getPrimaryHostname, parseOptionalHttpUrl } from "../../lib/validators";
import { requireAdmin } from "../../middleware/auth";
import type { AuthedEnv } from "../../types";

/**
 * Most KV cache entries one sync purges. A Worker invocation gets 1,000 KV
 * operations; entries past the cap stay on a host that no longer routes here
 * and expire with the cache TTL.
 */
const SYNC_KV_PURGE_MAX = 500;

/** Removed hostnames bound per purge select: D1 caps a statement at 100 parameters, and the LIMIT takes one. */
const SYNC_PURGE_SELECT_CHUNK = 90;

const domainRoutes = new Hono<AuthedEnv>();

// Everything but the list is admin-only. `/:hostname/*` also matches `/sync`,
// `/:hostname` and `/:hostname/access`, but not `/`.
domainRoutes.use("/:hostname/*", requireAdmin);

// List domains user has access to (admin sees all)
domainRoutes.get("/", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);
  // The primary host has a config row (redirects, access mode) but cannot hold links:
  // its links live with domainHostname NULL. Clients use isPrimary to hide it where a
  // custom domain is being chosen.
  const primaryHost = getPrimaryHostname(c.env.BETTER_AUTH_URL);

  // Non-admin: domains where accessMode='all' OR user's email is in domain_access
  const rows = await db.select().from(domainConfig).where(user.isAdmin ? undefined : or(
    eq(domainConfig.accessMode, "all"),
    inArray(
      domainConfig.hostname,
      db.select({ hostname: domainAccess.hostname }).from(domainAccess).where(eq(domainAccess.email, user.email.toLowerCase())),
    ),
  ));
  return c.json({ data: rows.map(row => ({ ...row, isPrimary: row.hostname === primaryHost })) });
});

// Sync domains from Cloudflare API → D1
domainRoutes.post("/sync", async (c) => {
  const { CF_ACCOUNT_ID, CF_API_TOKEN, WORKER_NAME, BETTER_AUTH_URL } = c.env;

  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw badRequest("CF_ACCOUNT_ID and CF_API_TOKEN must be configured");
  }

  // Fetch worker domains from Cloudflare API (paginated). Hostnames are stored lowercased.
  const cfHostnames = new Set<string>();
  let page = 1;
  while (true) {
    const apiRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/domains?service=${WORKER_NAME}&per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!apiRes.ok) {
      const body = await apiRes.text();
      throw new HTTPException(502, { message: `Cloudflare API error: ${apiRes.status} ${body.slice(0, 200)}` });
    }

    const apiData = await apiRes.json() as { result?: { hostname?: string }[]; result_info?: { total_pages?: number } };

    if (apiData.result) {
      for (const entry of apiData.result) {
        if (entry.hostname) cfHostnames.add(entry.hostname.toLowerCase());
      }
    }

    const totalPages = apiData.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }

  // Always include the primary hostname
  const primaryHost = getPrimaryHostname(BETTER_AUTH_URL);
  cfHostnames.add(primaryHost);

  const db = getDb(c.env.DB);
  const now = new Date();

  const existing = await db.select({ hostname: domainConfig.hostname }).from(domainConfig);
  const existingHostnames = new Set(existing.map(d => d.hostname));

  const batchOps: BatchItem<"sqlite">[] = [];
  for (const hostname of cfHostnames) {
    if (!existingHostnames.has(hostname)) {
      batchOps.push(
        db.insert(domainConfig).values({
          hostname,
          accessMode: "all",
          updatedAt: now,
        })
      );
    }
  }

  // Delete hostnames no longer in Cloudflare (except primary), along with their links.
  // The FK is "set null", which would silently move those links onto the primary host,
  // where the partial unique index can reject them and fail every later sync.
  const removed = [...existingHostnames].filter(hostname => !cfHostnames.has(hostname) && hostname !== primaryHost);
  if (removed.length > 0) {
    const purge: { slug: string; domainHostname: string | null }[] = [];
    for (let i = 0; i < removed.length && purge.length < SYNC_KV_PURGE_MAX; i += SYNC_PURGE_SELECT_CHUNK) {
      purge.push(...await db.select({ slug: links.slug, domainHostname: links.domainHostname })
        .from(links)
        .where(inArray(links.domainHostname, removed.slice(i, i + SYNC_PURGE_SELECT_CHUNK)))
        .limit(SYNC_KV_PURGE_MAX - purge.length));
    }
    await Promise.all(purge.map(link => deleteCachedRedirect(c.env.KV, link.slug, link.domainHostname)));
    for (const hostname of removed) {
      batchOps.push(
        db.delete(links).where(eq(links.domainHostname, hostname)),
        db.delete(domainConfig).where(eq(domainConfig.hostname, hostname)),
      );
    }
  }

  if (batchOps.length > 0) {
    await db.batch(batchOps as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  const updated = await db.select().from(domainConfig);
  return c.json({ data: updated });
});

domainRoutes.get("/:hostname", async (c) => {
  const hostname = c.req.param("hostname").toLowerCase();
  const db = getDb(c.env.DB);

  const config = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!config) throw notFound("Domain not found");

  const access = await db.select().from(domainAccess).where(eq(domainAccess.hostname, hostname));

  return c.json({ data: { ...config, accessEmails: access.map(a => a.email) } });
});

domainRoutes.put("/:hostname", async (c) => {
  const hostname = c.req.param("hostname").toLowerCase();
  const db = getDb(c.env.DB);

  const body = await parseJsonBody<{ rootRedirect?: string | null; notFoundRedirect?: string | null; accessMode?: unknown }>(c);

  const updates: Partial<typeof domainConfig.$inferInsert> = { updatedAt: new Date() };

  if (body.rootRedirect !== undefined) {
    updates.rootRedirect = parseOptionalHttpUrl(body.rootRedirect, "rootRedirect");
  }
  if (body.notFoundRedirect !== undefined) {
    updates.notFoundRedirect = parseOptionalHttpUrl(body.notFoundRedirect, "notFoundRedirect");
  }
  if (body.accessMode !== undefined) {
    const accessMode = body.accessMode;
    if (accessMode !== "all" && accessMode !== "restricted") {
      throw badRequest('accessMode must be "all" or "restricted"');
    }
    updates.accessMode = accessMode;
  }

  const updated = await db.update(domainConfig).set(updates).where(eq(domainConfig.hostname, hostname)).returning().get();
  if (!updated) throw notFound("Domain not found");
  return c.json({ data: updated });
});

domainRoutes.put("/:hostname/access", async (c) => {
  const hostname = c.req.param("hostname").toLowerCase();
  const db = getDb(c.env.DB);

  const config = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!config) throw notFound("Domain not found");

  const body = await parseJsonBody<{ emails: string[] }>(c);

  if (!Array.isArray(body.emails)) {
    throw badRequest("emails must be an array");
  }

  // Deduplicated after lowercasing: (hostname, email) is the primary key.
  const emails = [...new Set(body.emails
    .filter((e: unknown): e is string => typeof e === "string")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean))];

  for (const email of emails) {
    if (!email.includes("@") || email.length < 3) {
      throw badRequest(`Invalid email: ${email}`);
    }
  }

  const batchOps: BatchItem<"sqlite">[] = [
    db.delete(domainAccess).where(eq(domainAccess.hostname, hostname)),
  ];
  for (const email of emails) {
    batchOps.push(
      db.insert(domainAccess).values({ hostname, email })
    );
  }
  await db.batch(batchOps as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return c.json({ data: emails });
});

export default domainRoutes;
