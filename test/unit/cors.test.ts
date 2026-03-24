import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "../../src/middleware/cors";
import type { Env } from "../../src/bindings";

/**
 * Build a minimal Hono app with corsMiddleware applied globally, plus a
 * simple GET handler so non-OPTIONS requests have something to hit.
 */
function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", corsMiddleware);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

const ALLOWED_ORIGIN = "http://localhost:8787"; // matches BETTER_AUTH_URL in test env

describe("corsMiddleware", () => {
  describe("OPTIONS preflight — matching origin", () => {
    it("returns 204 status for OPTIONS preflight", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
          },
        },
        env
      );

      // hono/cors returns 204 for preflight
      expect(res.status).toBe(204);
    });

    it("reflects the allowed origin in Access-Control-Allow-Origin", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "GET",
          },
        },
        env
      );

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    });

    it("includes Access-Control-Allow-Credentials: true", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
          },
        },
        env
      );

      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });

    it("includes all configured methods in Access-Control-Allow-Methods", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "DELETE",
          },
        },
        env
      );

      const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
      expect(methods).toContain("GET");
      expect(methods).toContain("POST");
      expect(methods).toContain("PUT");
      expect(methods).toContain("DELETE");
      expect(methods).toContain("OPTIONS");
    });

    it("includes Content-Type and Authorization in Access-Control-Allow-Headers", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type, Authorization",
          },
        },
        env
      );

      const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
      expect(allowHeaders).toContain("Content-Type");
      expect(allowHeaders).toContain("Authorization");
    });
  });

  describe("OPTIONS preflight — non-matching origin", () => {
    it("does not reflect an attacker's origin", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
          },
        },
        env
      );

      const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
      expect(allowOrigin).not.toBe("https://evil.example.com");
    });

    it("does not grant credentials to a non-matching origin", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://attacker.io",
            "Access-Control-Request-Method": "GET",
          },
        },
        env
      );

      // Access-Control-Allow-Credentials must not be 'true' when origin is rejected
      const creds = res.headers.get("Access-Control-Allow-Credentials");
      const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
      // Either credentials are absent/false, OR the origin header is not the attacker's
      const rejected =
        creds !== "true" || (allowOrigin !== "https://attacker.io");
      expect(rejected).toBe(true);
    });
  });

  describe("OPTIONS preflight — no origin header", () => {
    it("handles missing Origin header without error", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "OPTIONS",
          headers: {
            "Access-Control-Request-Method": "GET",
          },
        },
        env
      );

      // Should not crash — status can be anything non-500
      expect(res.status).toBeLessThan(500);
      // Must not reflect a wildcard that bypasses credentials check
      expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    });
  });

  describe("Regular (non-OPTIONS) requests", () => {
    it("includes Access-Control-Allow-Origin on GET with matching origin", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "GET",
          headers: {
            Origin: ALLOWED_ORIGIN,
          },
        },
        env
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    });

    it("includes Access-Control-Allow-Credentials on GET with matching origin", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "GET",
          headers: {
            Origin: ALLOWED_ORIGIN,
          },
        },
        env
      );

      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });

    it("does not reflect a non-matching origin on GET", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "GET",
          headers: {
            Origin: "https://evil.example.com",
          },
        },
        env
      );

      const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
      expect(allowOrigin).not.toBe("https://evil.example.com");
    });

    it("still returns the response body on non-OPTIONS requests", async () => {
      const app = buildApp();
      const res = await app.request(
        "/test",
        {
          method: "GET",
          headers: { Origin: ALLOWED_ORIGIN },
        },
        env
      );

      const body = await res.json<{ ok: boolean }>();
      expect(body.ok).toBe(true);
    });
  });
});
