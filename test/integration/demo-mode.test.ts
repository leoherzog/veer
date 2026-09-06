import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { app } from "../../src/index";
import { createTestLink, mockExecutionCtx } from "../helpers";
import { hashPassword } from "../../src/services/password";

const demoEnv = { ...env, DEMO_MODE: "true" } as unknown as Env;

describe("Demo mode", () => {
  describe("GET /api/config", () => {
    it("returns demoMode: true when DEMO_MODE is 'true'", async () => {
      const res = await app.request("/api/config", {}, demoEnv);
      const body = await res.json<{ demoMode: boolean }>();
      expect(res.status).toBe(200);
      expect(body.demoMode).toBe(true);
    });

    it("returns demoMode: false when DEMO_MODE is unset", async () => {
      const res = await app.request("/api/config", {}, env);
      const body = await res.json<{ demoMode: boolean }>();
      expect(body.demoMode).toBe(false);
    });
  });

  describe("auth bypass", () => {
    it("GET /api/me without auth returns 200 with the synthetic demo user", async () => {
      const res = await app.request("/api/me", {}, demoEnv);
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { id: string; email: string } }>();
      expect(body.data.id).toBe("demo-user");
      expect(body.data.email).toBe("demo@veer.example");
    });

    it("GET /api/links without auth returns 200 (auth bypassed)", async () => {
      const res = await app.request("/api/links", {}, demoEnv);
      expect(res.status).toBe(200);
    });
  });

  describe("write blocking", () => {
    it("POST /api/links returns 403 with demoMode flag", async () => {
      const res = await app.request(
        "/api/links",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "should-fail", destinationUrl: "https://example.com" }),
        },
        demoEnv,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: string; demoMode: boolean }>();
      expect(body.demoMode).toBe(true);
      expect(body.error).toContain("Demo");
    });

    it("PUT /api/links/:id returns 403", async () => {
      const res = await app.request(
        "/api/links/anything",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destinationUrl: "https://example.com/new" }),
        },
        demoEnv,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ demoMode: boolean }>();
      expect(body.demoMode).toBe(true);
    });

    it("DELETE /api/links/:id returns 403", async () => {
      const res = await app.request("/api/links/anything", { method: "DELETE" }, demoEnv);
      expect(res.status).toBe(403);
    });

    it("POST /api/teams returns 403", async () => {
      const res = await app.request(
        "/api/teams",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x", slug: "x" }),
        },
        demoEnv,
      );
      expect(res.status).toBe(403);
    });

    // There is no login flow in demo mode, so the auth endpoints are blocked too.
    it.each([
      "/api/auth/sign-in/social",
      "/api/auth/sign-out",
      "/api/auth/sign-up/email",
    ])("POST %s returns 403 with demoMode flag", async (path) => {
      const res = await app.request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "github" }),
        },
        demoEnv,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: string; demoMode: boolean }>();
      expect(body.demoMode).toBe(true);
    });

    it("GET /api/auth/* is not blocked", async () => {
      const res = await app.request("/api/auth/get-session", {}, demoEnv);
      expect(res.status).not.toBe(403);
    });
  });

  describe("allowlist", () => {
    /** Seed the demo user row (FK on links.userId) plus a password-protected link. */
    async function seedProtectedLink(slug: string) {
      const now = Math.floor(Date.now() / 1000);
      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
           VALUES ('demo-user', 'Demo', 'demo@veer.example', 0, ?, ?)`,
        )
        .bind(now, now)
        .run();

      const passwordHash = await hashPassword("secret");
      return createTestLink(env.DB, { userId: "demo-user", slug, password: passwordHash });
    }

    it("POST /api/links/:id/check-password verifies the password", async () => {
      const link = await seedProtectedLink("demo-protected");

      const res = await app.request(
        `/api/links/${link.id}/check-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "secret" }),
        },
        demoEnv,
        mockExecutionCtx(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ valid: true });
    });

    it("POST /api/links/:id/check-password reports a wrong password", async () => {
      const link = await seedProtectedLink("demo-protected-wrong");

      const res = await app.request(
        `/api/links/${link.id}/check-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "nope" }),
        },
        demoEnv,
        mockExecutionCtx(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ valid: false });
    });

    it("POST /:slug password form is not blocked and redirects", async () => {
      await seedProtectedLink("demo-gate");

      const res = await app.request(
        "/demo-gate",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "password=secret",
        },
        demoEnv,
        mockExecutionCtx(),
      );
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://example.com");
    });
  });

  describe("non-demo regression", () => {
    it("POST /api/links without auth still returns 401 when DEMO_MODE is unset", async () => {
      const res = await app.request(
        "/api/links",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "x", destinationUrl: "https://example.com" }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });
  });
});
