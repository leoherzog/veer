import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { getConfiguredProviders } from "../lib/providers";
import type { Env } from "../bindings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authCache = new WeakMap<object, any>();

export function getAuth(env: Env) {
  const existing = authCache.get(env);
  if (existing) return existing;

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

  const auth = betterAuth({
    database: drizzleAdapter(getDb(env.DB), { provider: "sqlite", schema }),
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    socialProviders,
    trustedOrigins: [origin],
    plugins,
  });

  authCache.set(env, auth);
  return auth;
}

export type Auth = ReturnType<typeof getAuth>;
