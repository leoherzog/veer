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
