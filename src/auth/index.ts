import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { getConfiguredProviders } from "../lib/providers";
import { getInstanceName } from "../lib/branding";

function createAuth(env: Env) {
  const socialProviders = getConfiguredProviders(env);

  const origin = env.BETTER_AUTH_URL;
  const rpID = new URL(origin).hostname;

  const plugins = [];
  if (env.PASSKEY_ENABLED === "true") {
    plugins.push(passkey({ rpID, rpName: getInstanceName(env), origin }));
  }

  const db = getDb(env.DB);

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    socialProviders,
    plugins,
  });
}

const authCache = new WeakMap<Env, ReturnType<typeof createAuth>>();

/** Better Auth for this env, built once per env object. */
export function getAuth(env: Env) {
  let auth = authCache.get(env);
  if (!auth) {
    auth = createAuth(env);
    authCache.set(env, auth);
  }
  return auth;
}
