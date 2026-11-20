import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseDays, parseJsonBody, parsePagination, stripPassword } from "../../src/lib/request";
import type { AppEnv } from "../../src/types";

describe("parsePagination", () => {
  async function withQuery(query: string) {
    const app = new Hono<AppEnv>();
    let result: { page: number; limit: number; offset: number } | null = null;
    app.get("/t", (c) => {
      result = parsePagination(c);
      return c.text("ok");
    });
    await app.request(`/t?${query}`);
    return result!;
  }

  // OFFSET must be an integer; D1 rejects a fractional one with a datatype
  // mismatch, so fractional values are floored, not rejected.
  it.each([
    ["", { page: 1, limit: 20, offset: 0 }],
    ["page=3&limit=10", { page: 3, limit: 10, offset: 20 }],
    ["page=0", { page: 1, limit: 20, offset: 0 }],
    ["page=-5", { page: 1, limit: 20, offset: 0 }],
    ["limit=-10", { page: 1, limit: 1, offset: 0 }],
    // A limit of 0 is falsy and takes the default.
    ["limit=0", { page: 1, limit: 20, offset: 0 }],
    ["limit=500", { page: 1, limit: 100, offset: 0 }],
    ["page=abc&limit=xyz", { page: 1, limit: 20, offset: 0 }],
    ["page=1.3&limit=10.9", { page: 1, limit: 10, offset: 0 }],
    ["page=2.7&limit=10", { page: 2, limit: 10, offset: 10 }],
    ["page=Infinity&limit=Infinity", { page: 1, limit: 20, offset: 0 }],
    ["limit=0.5", { page: 1, limit: 1, offset: 0 }],
  ])("parses %j as %j", async (query, expected) => {
    expect(await withQuery(query)).toEqual(expected);
  });
});

describe("parseDays", () => {
  it("defaults to 30 when absent, non-numeric or below 1", () => {
    for (const raw of [undefined, "", "abc", "0", "-5"]) expect(parseDays(raw)).toBe(30);
  });

  it("truncates a fractional value and caps at 90", () => {
    expect(parseDays("2.5")).toBe(2);
    expect(parseDays("365")).toBe(90);
  });
});

/** Routes /j through parseJsonBody. */
const parseApp = new Hono<AppEnv>();
// Match the production app's onError so HTTPException rendering is identical
parseApp.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  return c.json({ error: String(err) }, 500);
});
parseApp.post("/j", async (c) => c.json(await parseJsonBody<{ ok: boolean }>(c)));

describe("parseJsonBody", () => {
  it("parses a valid JSON body", async () => {
    const res = await parseApp.request("/j", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ ok: boolean }>();
    expect(json.ok).toBe(true);
  });

  it("returns 400 Invalid JSON body for malformed JSON", async () => {
    const res = await parseApp.request("/j", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("Invalid JSON body");
  });
});

describe("stripPassword", () => {
  it("removes the password field and sets hasPassword:true when set", () => {
    const input = { id: "1", password: "some-hash", title: "x" };
    const out = stripPassword(input);
    expect(out).toEqual({ id: "1", title: "x", hasPassword: true });
    expect("password" in out).toBe(false);
  });

  it.each([
    ["null", { id: "1", password: null }],
    ["an empty string", { id: "1", password: "" }],
    ["missing", { id: "1" }],
  ])("sets hasPassword:false when password is %s", (_label, input: { id: string; password?: string | null }) => {
    expect(stripPassword(input).hasPassword).toBe(false);
  });
});
