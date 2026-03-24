import type { Env } from "./bindings";

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
  Variables: { user: AuthUser };
};
