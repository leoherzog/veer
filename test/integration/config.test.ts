import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { api } from "../helpers";

type Config = { instanceName: string; demoMode: boolean; providers: string[]; passkey: boolean };

describe("GET /api/config", () => {
  it("returns 200 with the default instance name when INSTANCE_NAME is unset", async () => {
    const res = await api("GET", "/api/config");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ instanceName: "Veer", demoMode: false, providers: [], passkey: false });
  });

  it("reflects a configured INSTANCE_NAME override", async () => {
    // The vars type INSTANCE_NAME as the configured literals, so an arbitrary name needs the cast.
    const res = await api("GET", "/api/config", { env: { ...env, INSTANCE_NAME: "Acme Links" } as unknown as Cloudflare.Env });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instanceName: "Acme Links", demoMode: false, providers: [], passkey: false });
  });

  // vitest.config.ts pins every provider credential to "", so each case sets only the ones it needs.
  describe("login providers", () => {
    it("returns exactly ['github'] when only GitHub creds are set", async () => {
      const res = await api("GET", "/api/config", {
        env: { ...env, GITHUB_CLIENT_ID: "test-id", GITHUB_CLIENT_SECRET: "test-secret" },
      });
      expect((await res.json<Config>()).providers).toEqual(["github"]);
    });

    it("returns passkey true when PASSKEY_ENABLED is 'true'", async () => {
      const res = await api("GET", "/api/config", { env: { ...env, PASSKEY_ENABLED: "true" } });
      expect((await res.json<Config>()).passkey).toBe(true);
    });
  });
});
