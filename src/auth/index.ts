import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { getDb } from "../db";
import { getConfiguredProviders } from "../lib/providers";
import type { Env } from "../bindings";

export function getAuth(env: Env) {
  const providers = getConfiguredProviders(env);
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const [id, creds] of providers) {
    socialProviders[id] = creds;
  }

  const origin = env.BETTER_AUTH_URL;
  const rpID = new URL(origin).hostname;

  const plugins = [];
  if (env.PASSKEY_ENABLED === "true") {
    plugins.push(passkey({ rpID, rpName: "Veer", origin }));
  }

  return betterAuth({
    database: drizzleAdapter(getDb(env.DB), { provider: "sqlite" }),
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    socialProviders,
    trustedOrigins: [origin],
    plugins,
  });
}

export type Auth = ReturnType<typeof getAuth>;
