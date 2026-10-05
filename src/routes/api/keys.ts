import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import { apiKeys } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { parseJsonBody } from "../../lib/request";
import { hashApiKey, generateApiKey } from "../../lib/crypto";
import { parseExpiresAt } from "../../lib/validators";
import type { AppEnv } from "../../types";

const app = new Hono<AppEnv>();

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

app.post("/", async (c) => {
  const body = await parseJsonBody<{ name?: string; expiresAt?: string | number }>(c);

  const name = body.name?.trim();
  if (!name) throw badRequest("name is required");

  const db = getDb(c.env.DB);

  if (await db.$count(apiKeys, eq(apiKeys.userId, c.var.user!.id)) >= 10) {
    throw badRequest("Maximum 10 API keys per user");
  }

  const expiresAt = body.expiresAt ? parseExpiresAt(body.expiresAt) : null;

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
