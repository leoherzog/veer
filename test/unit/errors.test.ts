import { describe, it, expect } from "vitest";
import { badRequest, notFound, conflict } from "../../src/lib/errors";
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
});
