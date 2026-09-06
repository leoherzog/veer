import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The suite applies these in test/setup.ts, so tests run against the same DDL
// D1 gets from `wrangler d1 migrations apply`.
const migrations = await readD1Migrations("drizzle/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          BETTER_AUTH_SECRET: "test-secret-minimum-32-characters-long",
          BETTER_AUTH_URL: "http://localhost:8787",
          CF_ACCOUNT_ID: "test-account-id",
          CF_API_TOKEN: "test-api-token",
          // The pool loads the developer's .dev.vars, so every var the app reads
          // is pinned here: an uncommented DEMO_MODE or a real ADMIN_EMAILS
          // would otherwise bypass auth and flip isAdmin under test.
          PASSKEY_ENABLED: "false",
          DEMO_MODE: "",
          INSTANCE_NAME: "",
          ADMIN_EMAILS: "",
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
          GITHUB_CLIENT_ID: "",
          GITHUB_CLIENT_SECRET: "",
          MICROSOFT_CLIENT_ID: "",
          MICROSOFT_CLIENT_SECRET: "",
          DISCORD_CLIENT_ID: "",
          DISCORD_CLIENT_SECRET: "",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
