import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseDays, parseJsonBody, parseOptionalJsonBody, parsePagination, stripPassword } from "../../src/lib/request";
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

  it("uses defaults when no query params", async () => {
    const r = await withQuery("");
    expect(r).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it("computes offset from page × limit", async () => {
    const r = await withQuery("page=3&limit=10");
    expect(r).toEqual({ page: 3, limit: 10, offset: 20 });
  });

  it("clamps page to minimum of 1 for zero or negative", async () => {
    expect((await withQuery("page=0")).page).toBe(1);
    expect((await withQuery("page=-5")).page).toBe(1);
  });

  it("clamps limit to minimum of 1 for negative values", async () => {
    const r = await withQuery("limit=-10");
    expect(r.limit).toBe(1);
  });

  it("falls back to default limit=20 when limit=0 (falsy)", async () => {
    // Number(0) || 20 = 20
    const r = await withQuery("limit=0");
    expect(r.limit).toBe(20);
  });

  it("clamps limit to maximum of 100", async () => {
    const r = await withQuery("limit=500");
    expect(r.limit).toBe(100);
  });

  it("treats non-numeric page/limit as defaults", async () => {
    const r = await withQuery("page=abc&limit=xyz");
    expect(r).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  // OFFSET must be an integer; D1 rejects a fractional one with a datatype
  // mismatch, so a fractional page is floored, not rejected.
  it("floors a fractional page and limit", async () => {
    const r = await withQuery("page=1.3&limit=10.9");
    expect(r).toEqual({ page: 1, limit: 10, offset: 0 });
    expect(Number.isInteger(r.offset)).toBe(true);
  });

  it("floors a fractional page above 2", async () => {
    const r = await withQuery("page=2.7&limit=10");
    expect(r).toEqual({ page: 2, limit: 10, offset: 10 });
  });

  it("treats infinite page/limit as defaults", async () => {
    const r = await withQuery("page=Infinity&limit=Infinity");
    expect(r).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it("floors a fractional limit below 1 up to the minimum", async () => {
    const r = await withQuery("limit=0.5");
    expect(r.limit).toBe(1);
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

/** Routes /j through parseJsonBody and /o through parseOptionalJsonBody. */
const parseApp = new Hono<AppEnv>();
// Match the production app's onError so HTTPException rendering is identical
parseApp.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  return c.json({ error: String(err) }, 500);
});
parseApp.post("/j", async (c) => c.json(await parseJsonBody<{ ok: boolean }>(c)));
parseApp.post("/o", async (c) => c.json({ body: await parseOptionalJsonBody<{ ok?: boolean }>(c) }));

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

describe("parseOptionalJsonBody", () => {
  it("returns the parsed body when one is sent", async () => {
    const res = await parseApp.request("/o", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    const json = await res.json<{ body: { ok: boolean } | null }>();
    expect(json.body).toEqual({ ok: true });
  });

  it("returns null when no body is sent", async () => {
    const res = await parseApp.request("/o", { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json<{ body: unknown }>();
    expect(json.body).toBeNull();
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
