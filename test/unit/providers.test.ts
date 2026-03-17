import { describe, it, expect } from "vitest";
import { getConfiguredProviders } from "../../src/lib/providers";

const BASE_ENV = {
  BETTER_AUTH_URL: "http://localhost:8787",
  BETTER_AUTH_SECRET: "test-secret",
  CF_ACCOUNT_ID: "test",
  CF_API_TOKEN: "test",
} as any;

function envWith(extra: Record<string, string>) {
  return { ...BASE_ENV, ...extra } as any;
}

describe("getConfiguredProviders", () => {
  it("returns an empty map when no providers are configured", () => {
    const result = getConfiguredProviders(BASE_ENV);
    expect(result.size).toBe(0);
  });

  it("detects a single provider (GitHub)", () => {
    const env = envWith({
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
    });
    const result = getConfiguredProviders(env);
    expect(result.size).toBe(1);
    expect(result.get("github")).toEqual({
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
    expect(result.size).toBe(4);
    expect([...result.keys()].sort()).toEqual(
      ["discord", "github", "google", "microsoft"],
    );
  });

  it("excludes a provider when only the client ID is set", () => {
    const env = envWith({
      GITHUB_CLIENT_ID: "gh-id",
      // no GITHUB_CLIENT_SECRET
    });
    const result = getConfiguredProviders(env);
    expect(result.size).toBe(0);
  });

  it("excludes a provider when only the client secret is set", () => {
    const env = envWith({
      GITHUB_CLIENT_SECRET: "gh-secret",
      // no GITHUB_CLIENT_ID
    });
    const result = getConfiguredProviders(env);
    expect(result.size).toBe(0);
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
    expect(result.size).toBe(1);
    expect(result.has("google")).toBe(true);
  });
});
