import { HTTPException } from "hono/http-exception";

export function badRequest(message: string): HTTPException {
  return new HTTPException(400, { message });
}

export function notFound(message = "Not found"): HTTPException {
  return new HTTPException(404, { message });
}

export function forbidden(message = "Forbidden"): HTTPException {
  return new HTTPException(403, { message });
}

export function conflict(message: string): HTTPException {
  return new HTTPException(409, { message });
}

export function checkBodySize(contentLength: string | undefined | null): void {
  if (!contentLength) return; // Workers runtime enforces its own body size limits
  const len = parseInt(contentLength, 10);
  if (len > 10_000) {
    throw new HTTPException(413, { message: "Request body too large" });
  }
}

