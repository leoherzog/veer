// Demo-mode constants. The synthetic user is injected by the auth middleware
// (src/middleware/auth.ts) when DEMO_MODE=true, so visitors never go through
// OAuth. The /api/* write-block middleware in src/index.ts intentionally blocks
// POST/PUT/PATCH/DELETE under /api/auth/* as well — there is no real login flow
// in demo mode, so sign-in/sign-out endpoints should never be reachable.
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
