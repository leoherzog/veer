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

export function parsePagination(c: Context): { page: number; limit: number; offset: number } {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** Strip the password hash from a link object, replacing it with a boolean flag. */
export function stripPassword<T extends { password?: string | null }>(link: T): Omit<T, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = link;
  return { ...rest, hasPassword: !!password };
}
