import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { app } from "../../src/index";
import { setupAuth, mockExecutionCtx } from "../helpers";

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

    it("carries the headers on an HTTPException error response", async () => {
      const auth = await setupAuth(env);
      const res = await app.request("/api/keys/does-not-exist", {
        method: "DELETE",
        headers: auth.headers,
      }, env, mockExecutionCtx());

      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("carries the headers on a 500 from an unhandled error", async () => {
      // An unparseable BETTER_AUTH_URL makes getAuth() throw inside the auth
      // middleware, which is the shortest route to the generic 500 handler.
      const brokenEnv = { ...env, BETTER_AUTH_URL: "not-a-url" };
      const res = await app.request("/api/me", {}, brokenEnv, mockExecutionCtx());

      expect(res.status).toBe(500);
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("CSP allows the choropleth's topojson source and locks down framing and forms", async () => {
      const res = await app.request("/api/auth/providers", {}, env);
      const csp = res.headers.get("Content-Security-Policy") ?? "";

      const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src ")) ?? "";
      expect(connectSrc).toContain("https://cdn.jsdelivr.net");

      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("object-src 'none'");
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

    it("returns the 404 JSON envelope for an unknown link report", async () => {
      const auth = await setupAuth(env);
      const res = await app.request("/api/reports/no-such-link", {
        headers: auth.headers,
      }, env, mockExecutionCtx());

      expect(res.status).toBe(404);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("Link not found");
    });

    it("non-existent API path returns a JSON 404, not the SPA shell", async () => {
      const res = await app.request("/api/nonexistent", {}, env);

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    });

    it("non-existent nested API path returns a JSON 404 for every method", async () => {
      for (const method of ["GET", "POST", "DELETE"]) {
        const res = await app.request("/api/no/such/thing", { method }, env, mockExecutionCtx());
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found" });
      }
    });
  });

  // ── Admin user management ────────────────────────────────────────────

  describe("Admin users", () => {
    /** Session headers plus the env that makes that session an admin. */
    async function setupAdmin() {
      const email = `app-admin-${Date.now()}@example.com`;
      const adminEnv = { ...env, ADMIN_EMAILS: email };
      const auth = await setupAuth(adminEnv, { email });
      return { adminEnv, headers: auth.headers, id: auth.user.id };
    }

    it("finds a user whose name contains an underscore", async () => {
      const { adminEnv, headers } = await setupAdmin();
      const target = await setupAuth(env, {
        email: `under_score-${Date.now()}@example.com`,
        name: "Under_Score Person",
      });

      const res = await app.request(
        "/api/admin/users?q=Under_Score",
        { headers },
        adminEnv,
        mockExecutionCtx()
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { id: string }[] }>();
      expect(body.data.map((u) => u.id)).toContain(target.user.id);
    });

    it("treats an underscore as a literal, not a single-character wildcard", async () => {
      const { adminEnv, headers } = await setupAdmin();
      await setupAuth(env, { email: `plain-${Date.now()}@example.com`, name: "Plain Person" });

      const res = await app.request("/api/admin/users?q=_", { headers }, adminEnv, mockExecutionCtx());
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { name: string; email: string }[] }>();
      for (const u of body.data) {
        expect(`${u.name}${u.email}`).toContain("_");
      }
    });

    it("rejects maxLinks below 1 and accepts null as unlimited", async () => {
      const { adminEnv, headers, id } = await setupAdmin();

      for (const maxLinks of [0, -5]) {
        const res = await app.request(`/api/admin/users/${id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ maxLinks }),
        }, adminEnv, mockExecutionCtx());
        expect(res.status).toBe(400);
        const body = await res.json<{ error: string }>();
        expect(body.error).toBe("maxLinks must be at least 1, or null for unlimited");
      }

      const ok = await app.request(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ maxLinks: null }),
      }, adminEnv, mockExecutionCtx());
      expect(ok.status).toBe(200);
      const okBody = await ok.json<{ data: { maxLinks: number | null } }>();
      expect(okBody.data.maxLinks).toBeNull();
    });
  });
});
