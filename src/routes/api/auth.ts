import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getAuth } from "../../auth";
import { getConfiguredProviders } from "../../lib/providers";

const authRoutes = new Hono<AppEnv>();

authRoutes.get("/providers", (c) => {
  const providers = getConfiguredProviders(c.env);
  return c.json({
    providers: [...providers.keys()],
    passkey: c.env.PASSKEY_ENABLED === "true",
  });
});

authRoutes.on(["POST", "GET"], "/*", async (c) => {
  const auth = getAuth(c.env);
  return auth.handler(c.req.raw);
});

export default authRoutes;
