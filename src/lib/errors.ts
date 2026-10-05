import { HTTPException } from "hono/http-exception";

export function badRequest(message: string): HTTPException {
  return new HTTPException(400, { message });
}

export function notFound(message: string): HTTPException {
  return new HTTPException(404, { message });
}

export function forbidden(message: string): HTTPException {
  return new HTTPException(403, { message });
}

export function conflict(message: string): HTTPException {
  return new HTTPException(409, { message });
}

/** True for a D1 UNIQUE constraint failure, which Drizzle may wrap in `cause`. */
export function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes("UNIQUE constraint")
    || (e.cause instanceof Error && e.cause.message.includes("UNIQUE constraint"));
}
