import type { Context } from "hono";
import { badRequest, checkBodySize } from "./errors";

export async function parseJsonBody<T>(c: Context): Promise<T> {
  checkBodySize(c.req.header("content-length"));
  try {
    return await c.req.json<T>();
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

/** Parse a JSON body for endpoints where an absent or empty body is meaningful. Size limit still applies. */
export async function parseOptionalJsonBody<T>(c: Context): Promise<T | null> {
  checkBodySize(c.req.header("content-length"));
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

/** Strip the password hash from a link object, replacing it with a boolean flag. */
export function stripPassword<T extends { password?: string | null }>(link: T): Omit<T, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = link;
  return { ...rest, hasPassword: !!password };
}
