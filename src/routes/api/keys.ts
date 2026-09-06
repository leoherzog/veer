import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { apiKeys } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { hashApiKey, generateApiKey } from "../../lib/crypto";
import type { AppEnv } from "../../types";

const app = new Hono<AppEnv>();

// GET / - List user's API keys
app.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const userId = c.var.user!.id;

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId));

  return c.json({ data: rows });
});

// POST / - Generate a new API key
app.post("/", async (c) => {
  const body = await parseJsonBody<{ name?: string; expiresAt?: string }>(c);

  const name = body.name?.trim();
  if (!name) throw badRequest("name is required");

  const db = getDb(c.env.DB);

  // Enforce per-user key limit
  const existingCount = await db.select({ count: sql<number>`count(*)` })
    .from(apiKeys)
    .where(eq(apiKeys.userId, c.var.user!.id));
  if ((existingCount[0]?.count ?? 0) >= 10) {
    throw badRequest("Maximum 10 API keys per user");
  }

  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    expiresAt = new Date(body.expiresAt);
    if (isNaN(expiresAt.getTime())) throw badRequest("Invalid expiresAt date");
    if (expiresAt <= new Date()) throw badRequest("expiresAt must be in the future");
  }

  const key = generateApiKey();
  const keyHash = await hashApiKey(key, c.env.BETTER_AUTH_SECRET);
  const prefix = key.slice(0, 12);
  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(apiKeys).values({
    id,
    userId: c.var.user!.id,
    name,
    keyHash,
    prefix,
    createdAt: now,
    expiresAt,
  });

  return c.json({ data: { id, name, prefix, key, expiresAt, createdAt: now } }, 201);
});

// DELETE /:id - Delete an API key belonging to the user
app.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const userId = c.var.user!.id;
  const keyId = c.req.param("id");

  const result = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)));

  if (!result.meta?.changes) throw notFound("API key not found");

  return c.json({ success: true });
});

export default app;
