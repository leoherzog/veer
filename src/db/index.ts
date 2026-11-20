import { drizzle } from "drizzle-orm/d1";

/**
 * A Drizzle client over the D1 binding. It carries no schema, so `db.query` is
 * empty; the Better Auth adapter gets the schema directly in `src/auth/index.ts`.
 */
export function getDb(d1: D1Database) {
  return drizzle(d1);
}

export type Database = ReturnType<typeof getDb>;
