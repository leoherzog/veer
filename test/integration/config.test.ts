import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { app } from "../../src/index";

type Config = { instanceName: string; demoMode: boolean; providers: string[]; passkey: boolean };

describe("GET /api/config", () => {
  it("returns 200 with the default instance name when INSTANCE_NAME is unset", async () => {
    const res = await app.request("/api/config", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = await res.json<Config>();
    expect(body).toEqual({ instanceName: "Veer", demoMode: false, providers: [], passkey: false });
  });

  it("reflects a configured INSTANCE_NAME override", async () => {
    const overridden = { ...env, INSTANCE_NAME: "Acme Links" } as unknown as Env;
    const res = await app.request("/api/config", {}, overridden);

    expect(res.status).toBe(200);
    const body = await res.json<Config>();
    expect(body).toEqual({ instanceName: "Acme Links", demoMode: false, providers: [], passkey: false });
  });

  // vitest.config.ts pins every provider credential to "", so each case sets only the ones it needs.
  describe("login providers", () => {
    it("returns exactly ['github'] when only GitHub creds are set", async () => {
      const res = await app.request("/api/config", {}, {
        ...env, GITHUB_CLIENT_ID: "test-id", GITHUB_CLIENT_SECRET: "test-secret",
      });
      const body = await res.json<Config>();
      expect(body.providers).toEqual(["github"]);
    });

    it("returns passkey true when PASSKEY_ENABLED is 'true'", async () => {
      const res = await app.request("/api/config", {}, { ...env, PASSKEY_ENABLED: "true" });
      const body = await res.json<Config>();
      expect(body.passkey).toBe(true);
    });
  });
});
