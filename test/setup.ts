// Applies drizzle/migrations to the test D1 before each test file, so the suite
// runs against the same DDL a real deployment gets.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Migrations read by vitest.config.ts and passed through as a binding. */
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
