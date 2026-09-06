import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { getConfiguredProviders } from "../../src/lib/providers";

// Every provider credential is present but empty, matching how an unconfigured
// deployment reads: the keys exist on Env, their values are falsy. The cast is
// needed because `wrangler types` types each wrangler.jsonc var as a literal union
// of its configured values, which no test-local origin can satisfy.
const BASE_ENV = {
  BETTER_AUTH_URL: "http://localhost:8787",
  BETTER_AUTH_SECRET: "test-secret",
  CF_ACCOUNT_ID: "test",
  CF_API_TOKEN: "test",
  ADMIN_EMAILS: "",
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  ANALYTICS: {} as AnalyticsEngineDataset,
  ASSETS: {} as Fetcher,
  WORKER_NAME: "veer" as const,
  PASSKEY_ENABLED: "false",
  INSTANCE_NAME: "",
  DEMO_MODE: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GITHUB_CLIENT_ID: "",
  GITHUB_CLIENT_SECRET: "",
  MICROSOFT_CLIENT_ID: "",
  MICROSOFT_CLIENT_SECRET: "",
  DISCORD_CLIENT_ID: "",
  DISCORD_CLIENT_SECRET: "",
} as unknown as Env;

function envWith(extra: Partial<Record<keyof Env, string>>): Env {
  return { ...BASE_ENV, ...extra } as Env;
}

describe("getConfiguredProviders", () => {
  it("returns an empty object when no providers are configured", () => {
    const result = getConfiguredProviders(BASE_ENV);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("detects a single provider (GitHub)", () => {
    const env = envWith({
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
    });
    const result = getConfiguredProviders(env);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["github"]).toEqual({
      clientId: "gh-id",
      clientSecret: "gh-secret",
    });
  });

  it("detects all four providers", () => {
    const env = envWith({
      GOOGLE_CLIENT_ID: "g-id",
      GOOGLE_CLIENT_SECRET: "g-secret",
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
      MICROSOFT_CLIENT_ID: "ms-id",
      MICROSOFT_CLIENT_SECRET: "ms-secret",
      DISCORD_CLIENT_ID: "dc-id",
      DISCORD_CLIENT_SECRET: "dc-secret",
    });
    const result = getConfiguredProviders(env);
    expect(Object.keys(result)).toHaveLength(4);
    expect(Object.keys(result).sort()).toEqual(
      ["discord", "github", "google", "microsoft"],
    );
  });

  it("excludes a provider when only the client ID is set", () => {
    const env = envWith({
      GITHUB_CLIENT_ID: "gh-id",
      // no GITHUB_CLIENT_SECRET
    });
    const result = getConfiguredProviders(env);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("excludes a provider when only the client secret is set", () => {
    const env = envWith({
      GITHUB_CLIENT_SECRET: "gh-secret",
      // no GITHUB_CLIENT_ID
    });
    const result = getConfiguredProviders(env);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("includes only fully configured providers in a mixed set", () => {
    const env = envWith({
      GOOGLE_CLIENT_ID: "g-id",
      GOOGLE_CLIENT_SECRET: "g-secret",
      GITHUB_CLIENT_ID: "gh-id",
      // missing GITHUB_CLIENT_SECRET
      DISCORD_CLIENT_SECRET: "dc-secret",
      // missing DISCORD_CLIENT_ID
    });
    const result = getConfiguredProviders(env);
    expect(Object.keys(result)).toHaveLength(1);
    expect("google" in result).toBe(true);
  });
});

describe("test bindings", () => {
  it("leaves every provider unconfigured and passkeys off", () => {
    // vitest.config.ts pins these; a developer's .dev.vars must not reach the suite.
    expect(getConfiguredProviders(env as unknown as Env)).toEqual({});
    expect(env.PASSKEY_ENABLED).toBe("false");
  });
});
