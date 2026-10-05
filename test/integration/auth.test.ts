import { describe, it, expect } from "vitest";
import { setupAuth, api } from "../helpers";

describe("Auth guards", () => {
  // One row per auth middleware mount; admin routes have their own matrix in admin.test.ts.
  it.each([
    ["GET", "/api/me"],
    ["GET", "/api/links"],
    ["GET", "/api/links/x"],
    ["GET", "/api/stats/x/summary"],
    ["GET", "/api/campaigns"],
    ["GET", "/api/campaigns/x"],
    ["GET", "/api/domains"],
    ["GET", "/api/domains/x"],
    ["GET", "/api/keys"],
    ["DELETE", "/api/keys/x"],
    ["POST", "/api/bulk"],
    ["GET", "/api/reports/x"],
    ["GET", "/api/teams"],
    ["GET", "/api/teams/x"],
  ])("%s %s without a session returns 401", async (method, path) => {
    const res = await api(method, path);

    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBeDefined();
  });

  it("GET /api/me with valid session returns 200 with user data", async () => {
    const auth = await setupAuth();

    const res = await api("GET", "/api/me", { headers: auth.headers });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; email: string } };
    expect(body.data.id).toBe(auth.user.id);
  });
});
