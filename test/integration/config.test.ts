import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import app from "../../src/index";

describe("GET /api/config", () => {
  it("returns 200 with the default instance name when INSTANCE_NAME is unset", async () => {
    const res = await app.request("/api/config", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = await res.json<{ instanceName: string }>();
    expect(body).toEqual({ instanceName: "Veer" });
  });

  it("is reachable without authentication", async () => {
    // No Authorization / Cookie header — must not 401
    const res = await app.request("/api/config", {}, env);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("reflects a configured INSTANCE_NAME override", async () => {
    const overridden: Env = { ...env, INSTANCE_NAME: "Acme Links" };
    const res = await app.request("/api/config", {}, overridden);

    expect(res.status).toBe(200);
    const body = await res.json<{ instanceName: string }>();
    expect(body).toEqual({ instanceName: "Acme Links" });
  });
});
