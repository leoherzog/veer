import { describe, it, expect } from "vitest";
import { badRequest, notFound, forbidden, conflict, isUniqueViolation } from "../../src/lib/errors";
import { HTTPException } from "hono/http-exception";

describe("error helpers", () => {
  it.each([
    [badRequest, 400],
    [notFound, 404],
    [forbidden, 403],
    [conflict, 409],
  ] as const)("%o returns an HTTPException with status %i and the given message", (helper, status) => {
    const err = helper("some message");
    expect(err).toBeInstanceOf(HTTPException);
    expect(err.status).toBe(status);
    expect(err.message).toBe("some message");
  });

  describe("isUniqueViolation", () => {
    it("matches the message or a wrapped cause, and nothing else", () => {
      const d1 = new Error("D1_ERROR: UNIQUE constraint failed: links.slug");
      expect(isUniqueViolation(d1)).toBe(true);
      expect(isUniqueViolation(new Error("Failed query", { cause: d1 }))).toBe(true);
      expect(isUniqueViolation(new Error("FOREIGN KEY constraint failed"))).toBe(false);
      expect(isUniqueViolation("UNIQUE constraint failed")).toBe(false);
    });
  });
});
