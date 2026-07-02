import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth } from "../helpers";

describe("Auth endpoints", () => {
  // ── GET /api/auth/providers ──────────────────────────────────────────

  describe("GET /api/auth/providers", () => {
    it("returns providers list based on env config", async () => {
      const res = await app.request("/api/auth/providers", {}, env);
      const body = await res.json<{ providers: string[]; passkey: boolean }>();

      expect(res.status).toBe(200);
      expect(Array.isArray(body.providers)).toBe(true);
      // Note: .dev.vars may inject real OAuth secrets, so providers may not be empty
    });

    it("returns exactly ['github'] when only GitHub creds are set", async () => {
      const envWithGithub = {
        ...env,
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: "test-secret",
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        MICROSOFT_CLIENT_ID: undefined,
        MICROSOFT_CLIENT_SECRET: undefined,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
      };

      const res = await app.request("/api/auth/providers", {}, envWithGithub);
      const body = await res.json<{ providers: string[] }>();

      expect(res.status).toBe(200);
      expect(body.providers).toEqual(["github"]);
    });

    it("includes multiple providers when configured, and excludes unconfigured ones", async () => {
      const envWithMultiple = {
        ...env,
        GITHUB_CLIENT_ID: "gh-id",
        GITHUB_CLIENT_SECRET: "gh-secret",
        GOOGLE_CLIENT_ID: "g-id",
        GOOGLE_CLIENT_SECRET: "g-secret",
        MICROSOFT_CLIENT_ID: undefined,
        MICROSOFT_CLIENT_SECRET: undefined,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
      };

      const res = await app.request("/api/auth/providers", {}, envWithMultiple);
      const body = await res.json<{ providers: string[] }>();

      expect(body.providers.sort()).toEqual(["github", "google"]);
      expect(body.providers).not.toContain("microsoft");
      expect(body.providers).not.toContain("discord");
    });

    it("excludes a provider when clientId is set but clientSecret is missing", async () => {
      const envWithPartialGithub = {
        ...env,
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        MICROSOFT_CLIENT_ID: undefined,
        MICROSOFT_CLIENT_SECRET: undefined,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
      };

      const res = await app.request("/api/auth/providers", {}, envWithPartialGithub);
      const body = await res.json<{ providers: string[] }>();

      expect(res.status).toBe(200);
      expect(body.providers).not.toContain("github");
      expect(body.providers).toEqual([]);
    });

    it("returns an empty list when no provider creds are set", async () => {
      const envWithNoProviders = {
        ...env,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
        MICROSOFT_CLIENT_ID: undefined,
        MICROSOFT_CLIENT_SECRET: undefined,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
      };

      const res = await app.request("/api/auth/providers", {}, envWithNoProviders);
      const body = await res.json<{ providers: string[] }>();

      expect(res.status).toBe(200);
      expect(body.providers).toEqual([]);
    });

    it("returns passkey true when PASSKEY_ENABLED is 'true'", async () => {
      const envWithPasskey = {
        ...env,
        PASSKEY_ENABLED: "true",
      };

      const res = await app.request("/api/auth/providers", {}, envWithPasskey);
      const body = await res.json<{ passkey: boolean }>();

      expect(body.passkey).toBe(true);
    });
  });

  // ── Auth guards ──────────────────────────────────────────────────────

  describe("Auth guards", () => {
    it("GET /api/me without auth returns 401", async () => {
      const res = await app.request("/api/me", {}, env);

      expect(res.status).toBe(401);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBeDefined();
    });

    it("GET /api/links without auth returns 401", async () => {
      const res = await app.request("/api/links", {}, env);

      expect(res.status).toBe(401);
    });

    it("POST /api/links without auth returns 401", async () => {
      const res = await app.request(
        "/api/links",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "test", destinationUrl: "https://example.com" }),
        },
        env
      );

      expect(res.status).toBe(401);
    });

    it("GET /api/me with valid session returns 200 with user data", async () => {
      const auth = await setupAuth(env);

      const res = await app.request(
        "/api/me",
        { headers: auth.headers },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ data: { id: string; email: string } }>();
      expect(body.data).toBeDefined();
      expect(body.data.id).toBe(auth.user.id);
    });
  });
});
