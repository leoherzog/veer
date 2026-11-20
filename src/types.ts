/** Authenticated user shape injected by requireAuth middleware. */
export type AuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  isAdmin: boolean;
};

/** Shared Hono environment type used across the app. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    user?: AuthUser;
  };
};

/**
 * Hono environment for a sub-app that `src/index.ts` mounts only behind
 * requireAuth or requireAuthOrApiKey, so `c.var.user` is always set.
 */
export type AuthedEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
  };
};
