import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { app } from "../../src/index";
import { setupAuth } from "../helpers";

const BETTER_AUTH_URL = "http://localhost:8787";

describe("App-level concerns", () => {
  // ── Security headers ─────────────────────────────────────────────────

  describe("Security headers", () => {
    it("includes X-Content-Type-Options: nosniff on API routes", async () => {
      const res = await app.request("/api/auth/providers", {}, env);

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("includes X-Frame-Options: DENY on API routes", async () => {
      const res = await app.request("/api/auth/providers", {}, env);

      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("includes Referrer-Policy: strict-origin-when-cross-origin on API routes", async () => {
      const res = await app.request("/api/auth/providers", {}, env);

      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });

    it("includes security headers on non-API routes", async () => {
      // A slug that doesn't exist will fall through to SPA
      const res = await app.request("/nonexistent-page", {}, env);

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });
  });

  // ── CORS ─────────────────────────────────────────────────────────────

  describe("CORS", () => {
    it("OPTIONS /api/links with matching origin returns CORS headers", async () => {
      const res = await app.request(
        "/api/links",
        {
          method: "OPTIONS",
          headers: {
            Origin: BETTER_AUTH_URL,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
          },
        },
        env
      );

      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(BETTER_AUTH_URL);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    });
  });

  // ── Error handling ───────────────────────────────────────────────────

  describe("Error handling", () => {
    it("invalid JSON on POST /api/links with auth returns 400 JSON error", async () => {
      const auth = await setupAuth(env);

      const res = await app.request(
        "/api/links",
        {
          method: "POST",
          headers: {
            ...auth.headers,
            "Content-Type": "application/json",
          },
          body: "{ not valid json !!!",
        },
        env
      );

      // Should be a 400 (bad request) — the exact status depends on Hono's
      // body parsing, but it must not be a 500
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBeDefined();
    });

    it("non-existent API sub-route falls through to SPA (not a JSON 404)", async () => {
      // /api/nonexistent is not matched by any API route handler,
      // so it falls through to the SPA wildcard handler, which serves the
      // built index.html (200 text/html) rather than a JSON 404 envelope.
      const res = await app.request("/api/nonexistent", {}, env);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(() => JSON.parse(body)).toThrow();
    });
  });
});
