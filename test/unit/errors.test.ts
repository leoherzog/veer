import { describe, it, expect } from "vitest";
import { badRequest, notFound, forbidden, conflict, checkBodySize } from "../../src/lib/errors";
import { HTTPException } from "hono/http-exception";

describe("error helpers", () => {
  describe("badRequest", () => {
    it("returns an HTTPException with status 400", () => {
      const err = badRequest("invalid input");
      expect(err).toBeInstanceOf(HTTPException);
      expect(err.status).toBe(400);
    });

    it("includes the provided message", () => {
      const err = badRequest("missing field");
      expect(err.message).toBe("missing field");
    });
  });

  describe("notFound", () => {
    it("returns an HTTPException with status 404", () => {
      const err = notFound("no such link");
      expect(err).toBeInstanceOf(HTTPException);
      expect(err.status).toBe(404);
    });

    it("includes the provided message", () => {
      const err = notFound("link not found");
      expect(err.message).toBe("link not found");
    });

    it("uses default message when none provided", () => {
      const err = notFound();
      expect(err.message).toBe("Not found");
    });
  });

  describe("conflict", () => {
    it("returns an HTTPException with status 409", () => {
      const err = conflict("slug taken");
      expect(err).toBeInstanceOf(HTTPException);
      expect(err.status).toBe(409);
    });

    it("includes the provided message", () => {
      const err = conflict("already exists");
      expect(err.message).toBe("already exists");
    });
  });

  describe("forbidden", () => {
    it("returns an HTTPException with status 403", () => {
      const err = forbidden("nope");
      expect(err).toBeInstanceOf(HTTPException);
      expect(err.status).toBe(403);
    });

    it("uses default message when none provided", () => {
      const err = forbidden();
      expect(err.message).toBe("Forbidden");
    });

    it("includes the provided message", () => {
      const err = forbidden("access denied");
      expect(err.message).toBe("access denied");
    });
  });

  describe("checkBodySize", () => {
    it("does not throw when content-length is undefined", () => {
      expect(() => checkBodySize(undefined)).not.toThrow();
    });

    it("does not throw when content-length is null", () => {
      expect(() => checkBodySize(null)).not.toThrow();
    });

    it("does not throw when content-length is empty string", () => {
      // Empty string is falsy — intentionally skipped; runtime enforces limits
      expect(() => checkBodySize("")).not.toThrow();
    });

    it("does not throw at exactly 10000 bytes (boundary)", () => {
      expect(() => checkBodySize("10000")).not.toThrow();
    });

    it("throws 413 when content-length exceeds 10_000 bytes", () => {
      try {
        checkBodySize("10001");
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HTTPException);
        expect((err as HTTPException).status).toBe(413);
        expect((err as HTTPException).message).toBe("Request body too large");
      }
    });

    it("throws 413 for very large body", () => {
      expect(() => checkBodySize("999999")).toThrow(HTTPException);
    });
  });
});
