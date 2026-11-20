import { describe, it, expect, beforeAll } from "vitest";
import { api, createDemoUser, createTestLink, demoEnv } from "../helpers";
import { hashPassword } from "../../src/services/password";
import { DEMO_BLOCKED_MESSAGE, DEMO_USER, DEMO_USER_ID } from "../../src/lib/demo";

describe("Demo mode", () => {
  describe("GET /api/config", () => {
    it("returns demoMode: true when DEMO_MODE is 'true'", async () => {
      const res = await api("GET", "/api/config", { env: demoEnv });
      expect(res.status).toBe(200);
      expect((await res.json<{ demoMode: boolean }>()).demoMode).toBe(true);
    });
  });

  describe("auth bypass", () => {
    it("GET /api/me without auth returns the synthetic demo user", async () => {
      const res = await api("GET", "/api/me", { env: demoEnv });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: DEMO_USER });
    });

    it("never makes the demo user an admin, even when ADMIN_EMAILS lists its email", async () => {
      const res = await api("GET", "/api/me", { env: { ...demoEnv, ADMIN_EMAILS: DEMO_USER.email } });
      expect(await res.json()).toEqual({ data: DEMO_USER });
    });

    it("resolves a Bearer header to the demo user", async () => {
      const res = await api("GET", "/api/me", {
        env: demoEnv,
        headers: { Authorization: "Bearer veer_demoBearerResolvesToDemoUser0000000000" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: DEMO_USER });
    });

    it("GET /api/links without auth returns 200 (auth bypassed)", async () => {
      const res = await api("GET", "/api/links", { env: demoEnv });
      expect(res.status).toBe(200);
    });
  });

  describe("write blocking", () => {
    // Demo has no login flow, so the auth endpoints are blocked too.
    it.each<[string, string, unknown]>([
      ["POST", "/api/links", { slug: "should-fail", destinationUrl: "https://example.com" }],
      ["PUT", "/api/links/anything", { destinationUrl: "https://example.com/new" }],
      ["DELETE", "/api/links/anything", undefined],
      ["POST", "/api/teams", { name: "x" }],
      ["POST", "/api/auth/sign-in/social", { provider: "github" }],
      ["POST", "/api/auth/sign-out", {}],
      ["POST", "/api/auth/sign-up/email", {}],
    ])("%s %s returns 403 with the demo message", async (method, path, body) => {
      const res = await api(method, path, { env: demoEnv, body });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: DEMO_BLOCKED_MESSAGE, demoMode: true });
    });

    it("GET /api/auth/* is not blocked", async () => {
      // Better Auth answers a request with no session cookie with a JSON null.
      const res = await api("GET", "/api/auth/get-session", { env: demoEnv });
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    });

    it("HEAD passes the write block", async () => {
      const res = await api("HEAD", "/api/links", { env: demoEnv });
      expect(res.status).toBe(200);
    });

    it("OPTIONS passes the write block", async () => {
      // No route answers OPTIONS, so a request past the block reaches the JSON 404.
      const res = await api("OPTIONS", "/api/links", { env: demoEnv });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    });
  });

  describe("non-API writes", () => {
    // The demo user row satisfies the FK on links.userId.
    beforeAll(createDemoUser);

    it("POST /:slug password form is not blocked and redirects", async () => {
      await createTestLink({ userId: DEMO_USER_ID, slug: "demo-gate", password: await hashPassword("secret") });

      const res = await api("POST", "/demo-gate", { env: demoEnv, body: new URLSearchParams({ password: "secret" }) });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://example.com");
    });
  });
});
