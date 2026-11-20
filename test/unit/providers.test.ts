import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { getConfiguredProviders } from "../../src/lib/providers";

const ALL = {
  GOOGLE_CLIENT_ID: "g-id",
  GOOGLE_CLIENT_SECRET: "g-secret",
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  MICROSOFT_CLIENT_ID: "ms-id",
  MICROSOFT_CLIENT_SECRET: "ms-secret",
  DISCORD_CLIENT_ID: "dc-id",
  DISCORD_CLIENT_SECRET: "dc-secret",
};

// vitest.config.ts pins every provider credential to "", so each row sets only the ones it needs.
describe("getConfiguredProviders", () => {
  it.each<[string, Partial<typeof ALL>, ReturnType<typeof getConfiguredProviders>]>([
    ["no provider when none is configured", {}, {}],
    [
      "a provider with both credentials",
      { GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" },
      { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    ],
    [
      "all four providers",
      ALL,
      {
        google: { clientId: "g-id", clientSecret: "g-secret" },
        github: { clientId: "gh-id", clientSecret: "gh-secret" },
        microsoft: { clientId: "ms-id", clientSecret: "ms-secret" },
        discord: { clientId: "dc-id", clientSecret: "dc-secret" },
      },
    ],
    ["no provider with only a client ID", { GITHUB_CLIENT_ID: "gh-id" }, {}],
    ["no provider with only a client secret", { GITHUB_CLIENT_SECRET: "gh-secret" }, {}],
    [
      "only the fully configured providers of a mixed set",
      { GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret", GITHUB_CLIENT_ID: "gh-id", DISCORD_CLIENT_SECRET: "dc-secret" },
      { google: { clientId: "g-id", clientSecret: "g-secret" } },
    ],
  ])("returns %s", (_label, credentials, providers) => {
    expect(getConfiguredProviders({ ...env, ...credentials })).toEqual(providers);
  });
});
