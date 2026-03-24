import { Hono } from "hono";
import { eq, and, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../db";
import { domainConfig, domainAccess, links } from "../../db/schema";
import { deleteCachedRedirect } from "../../services/kv-cache";
import { HTTPException } from "hono/http-exception";
import { badRequest, notFound, checkBodySize } from "../../lib/errors";
import type { AppEnv } from "../../types";

function validateRedirectUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw badRequest("Redirect URL must use http or https");
    }
    return url;
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw badRequest("Invalid redirect URL");
  }
}

const domainRoutes = new Hono<AppEnv>();

// List domains user has access to (admin sees all)
domainRoutes.get("/", async (c) => {
  const user = c.var.user;
  const db = getDb(c.env.DB);

  if (user.isAdmin) {
    const rows = await db.select().from(domainConfig);
    return c.json({ data: rows });
  }

  // Non-admin: domains where accessMode='all' OR user's email is in domain_access
  const rows = await db.select({ hostname: domainConfig.hostname, rootRedirect: domainConfig.rootRedirect, notFoundRedirect: domainConfig.notFoundRedirect, accessMode: domainConfig.accessMode, updatedAt: domainConfig.updatedAt })
    .from(domainConfig)
    .where(
      or(
        eq(domainConfig.accessMode, "all"),
        sql`${domainConfig.hostname} IN (SELECT ${domainAccess.hostname} FROM ${domainAccess} WHERE ${domainAccess.email} = ${user.email.toLowerCase()})`
      )
    );
  return c.json({ data: rows });
});

// Sync domains from Cloudflare API → D1 (admin only, guarded in index.ts)
domainRoutes.post("/sync", async (c) => {
  const { CF_ACCOUNT_ID, CF_API_TOKEN, WORKER_NAME, BETTER_AUTH_URL } = c.env;

  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw badRequest("CF_ACCOUNT_ID and CF_API_TOKEN must be configured");
  }

  const workerName = WORKER_NAME || "veer";

  // Fetch worker domains from Cloudflare API (paginated)
  const cfHostnames = new Set<string>();
  let page = 1;
  while (true) {
    const apiRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/domains?service=${workerName}&per_page=100&page=${page}`,
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
  const primaryHost = new URL(BETTER_AUTH_URL).hostname;
  cfHostnames.add(primaryHost.toLowerCase());

  const db = getDb(c.env.DB);
  const now = new Date();

  // Get existing domains
  const existing = await db.select().from(domainConfig);
  const existingHostnames = new Set(existing.map(d => d.hostname));

  // Upsert new hostnames (preserve existing config)
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

  // Delete hostnames no longer in Cloudflare (except primary)
  // Clean up KV cache entries before deleting (FK cascade will set domainHostname to NULL,
  // but old hostname:slug KV keys would become orphaned)
  for (const row of existing) {
    if (!cfHostnames.has(row.hostname) && row.hostname !== primaryHost.toLowerCase()) {
      const domainLinks = await db.select({ slug: links.slug }).from(links)
        .where(eq(links.domainHostname, row.hostname));
      await Promise.all(domainLinks.map(link => deleteCachedRedirect(c.env.KV, link.slug, row.hostname)));
      batchOps.push(
        db.delete(domainConfig).where(eq(domainConfig.hostname, row.hostname))
      );
    }
  }

  if (batchOps.length > 0) {
    await db.batch(batchOps as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  // Return updated list
  const updated = await db.select().from(domainConfig);
  return c.json({ data: updated });
});

// Get domain config + access list (admin only)
domainRoutes.get("/:hostname", async (c) => {
  const hostname = c.req.param("hostname").toLowerCase();
  const db = getDb(c.env.DB);

  const config = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!config) throw notFound("Domain not found");

  const access = await db.select().from(domainAccess).where(eq(domainAccess.hostname, hostname));

  return c.json({ data: { ...config, accessEmails: access.map(a => a.email) } });
});

// Update domain config (admin only)
domainRoutes.put("/:hostname", async (c) => {
  const hostname = c.req.param("hostname").toLowerCase();
  const db = getDb(c.env.DB);

  const existing = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!existing) throw notFound("Domain not found");

  checkBodySize(c.req.header("content-length"));

  let body: { rootRedirect?: string | null; notFoundRedirect?: string | null; accessMode?: string };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  const updates: Partial<typeof domainConfig.$inferInsert> = { updatedAt: new Date() };

  if (body.rootRedirect !== undefined) {
    updates.rootRedirect = body.rootRedirect === null ? null : validateRedirectUrl(body.rootRedirect);
  }
  if (body.notFoundRedirect !== undefined) {
    updates.notFoundRedirect = body.notFoundRedirect === null ? null : validateRedirectUrl(body.notFoundRedirect);
  }
  if (body.accessMode !== undefined) {
    if (body.accessMode !== "all" && body.accessMode !== "restricted") {
      throw badRequest('accessMode must be "all" or "restricted"');
    }
    updates.accessMode = body.accessMode;
  }

  await db.update(domainConfig).set(updates).where(eq(domainConfig.hostname, hostname));

  // Re-fetch to return consistent data (avoids Date vs integer mismatch)
  const updated = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  return c.json({ data: updated });
});

// List access emails for a domain (admin only)
domainRoutes.get("/:hostname/access", async (c) => {
  const hostname = c.req.param("hostname").toLowerCase();
  const db = getDb(c.env.DB);

  const config = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!config) throw notFound("Domain not found");

  const access = await db.select().from(domainAccess).where(eq(domainAccess.hostname, hostname));
  return c.json({ data: access.map(a => a.email) });
});

// Set access emails for a domain (admin only)
domainRoutes.put("/:hostname/access", async (c) => {
  const hostname = c.req.param("hostname").toLowerCase();
  const db = getDb(c.env.DB);

  const config = await db.select().from(domainConfig).where(eq(domainConfig.hostname, hostname)).get();
  if (!config) throw notFound("Domain not found");

  checkBodySize(c.req.header("content-length"));

  let body: { emails: string[] };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!Array.isArray(body.emails)) {
    throw badRequest("emails must be an array");
  }

  const emails = body.emails
    .filter((e: unknown): e is string => typeof e === "string")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  for (const email of emails) {
    if (!email.includes("@") || email.length < 3) {
      throw badRequest(`Invalid email: ${email}`);
    }
  }

  // Replace all access entries atomically
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
