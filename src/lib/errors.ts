import { HTTPException } from "hono/http-exception";

export function badRequest(message: string): HTTPException {
  return new HTTPException(400, { message });
}

export function notFound(message = "Not found"): HTTPException {
  return new HTTPException(404, { message });
}

export function conflict(message: string): HTTPException {
  return new HTTPException(409, { message });
}

