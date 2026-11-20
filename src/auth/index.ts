import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { getConfiguredProviders } from "../lib/providers";
import { getInstanceName, isPasskeyEnabled } from "../lib/branding";

function createAuth(env: Env) {
  // Without a secret Better Auth signs with a public default string outside production.
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not set");

  return betterAuth({
    // The passkey rpName defaults to appName; rpID and origin derive from baseURL.
    appName: getInstanceName(env),
    database: drizzleAdapter(getDb(env.DB), { provider: "sqlite", schema }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // The cookie cache keeps its default 5-minute maxAge.
    session: { cookieCache: { enabled: true } },
    databaseHooks: {
      user: {
        create: {
          // isAdmin, domain access and invite accept all trust user.email, so a
          // provider that did not verify the address cannot create an account.
          // Better Auth then redirects the OAuth callback to its error URL.
          before: async (u) => (u.emailVerified ? undefined : false),
        },
      },
    },
    socialProviders: getConfiguredProviders(env),
    plugins: isPasskeyEnabled(env) ? [passkey()] : [],
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
