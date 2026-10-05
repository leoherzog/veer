import type { Context } from "hono";
import { or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { badRequest } from "./errors";

export async function parseJsonBody<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

/** Parse a JSON body for endpoints where an absent or empty body is meaningful. */
export async function parseOptionalJsonBody<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

export function parsePagination(c: Context): { page: number; limit: number; offset: number } {
  // Floor before clamping: a fractional page reaches SQLite as a fractional OFFSET.
  const rawPage = Math.floor(Number(c.req.query("page")) || 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const rawLimit = Math.floor(Number(c.req.query("limit")) || 20);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** A stats window in days from a query value: 30 when absent, invalid or below 1, capped at 90. */
export function parseDays(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 30;
  if (isNaN(n) || n < 1) return 30;
  return Math.min(n, 90);
}

/**
 * Case-insensitive substring match of `q` against any of `columns`, or undefined
 * for an empty query so Drizzle's `and()` drops it.
 */
export function searchFilter(q: string | undefined, ...columns: AnyColumn[]): SQL | undefined {
  const term = q?.trim();
  if (!term) return undefined;
  // `\`, `%` and `_` are escaped, so each LIKE needs the matching ESCAPE clause
  // or a query containing one of them matches nothing.
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  return or(...columns.map((col) => sql`${col} LIKE ${pattern} ESCAPE '\\'`));
}

/** Strip the password hash from a link object, replacing it with a boolean flag. */
export function stripPassword<T extends { password?: string | null }>(link: T): Omit<T, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = link;
  return { ...rest, hasPassword: !!password };
}
