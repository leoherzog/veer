import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "test-secret-minimum-32-characters-long",
          BETTER_AUTH_URL: "http://localhost:8787",
          CF_ACCOUNT_ID: "test-account-id",
          CF_API_TOKEN: "test-api-token",
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
