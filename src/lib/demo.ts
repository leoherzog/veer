// Demo-mode constants: the synthetic user the auth middleware injects and the
// 403 message for blocked writes. scripts/seed.ts runs this module under Node's
// type stripping, so a value import here needs an explicit `.ts` extension.
import type { AuthUser } from "../types";

export const DEMO_USER_ID = "demo-user";

export const DEMO_USER: AuthUser = {
  id: DEMO_USER_ID,
  name: "Demo User",
  email: "demo@veer.example",
  image: null,
  isAdmin: false,
};

export const DEMO_BLOCKED_MESSAGE =
  "Demo instance — clone the repo to host your own.";
