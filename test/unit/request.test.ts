import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseJsonBody, parseOptionalJsonBody, parsePagination, stripPassword } from "../../src/lib/request";
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

describe("parseJsonBody", () => {
  function appWithParse() {
    const app = new Hono<AppEnv>();
    // Match the production app's onError so HTTPException rendering is identical
    app.onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      return c.json({ error: String(err) }, 500);
    });
    app.post("/j", async (c) => {
      const body = await parseJsonBody<{ ok: boolean }>(c);
      return c.json(body);
    });
    return app;
  }

  it("parses a valid JSON body", async () => {
    const res = await appWithParse().request("/j", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ ok: boolean }>();
    expect(json.ok).toBe(true);
  });

  it("returns 400 Invalid JSON body for malformed JSON", async () => {
    const res = await appWithParse().request("/j", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("Invalid JSON body");
  });

  it("returns 413 when Content-Length exceeds 10_000", async () => {
    const res = await appWithParse().request("/j", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "20000" },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(413);
  });
});

describe("parseOptionalJsonBody", () => {
  function appWithOptionalParse() {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      return c.json({ error: String(err) }, 500);
    });
    app.post("/j", async (c) => {
      const body = await parseOptionalJsonBody<{ ok?: boolean }>(c);
      return c.json({ body });
    });
    return app;
  }

  it("returns the parsed body when one is sent", async () => {
    const res = await appWithOptionalParse().request("/j", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    const json = await res.json<{ body: { ok: boolean } | null }>();
    expect(json.body).toEqual({ ok: true });
  });

  it("returns null when no body is sent", async () => {
    const res = await appWithOptionalParse().request("/j", { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json<{ body: unknown }>();
    expect(json.body).toBeNull();
  });

  it("still returns 413 when Content-Length exceeds 10_000", async () => {
    const res = await appWithOptionalParse().request("/j", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "20000" },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(413);
  });
});

describe("stripPassword", () => {
  it("removes the password field and sets hasPassword:true when set", () => {
    const input = { id: "1", password: "some-hash", title: "x" };
    const out = stripPassword(input);
    expect(out).toEqual({ id: "1", title: "x", hasPassword: true });
    expect("password" in out).toBe(false);
  });

  it("sets hasPassword:false when password is null", () => {
    const out = stripPassword({ id: "1", password: null as string | null });
    expect(out.hasPassword).toBe(false);
  });

  it("sets hasPassword:false when password is empty string", () => {
    const out = stripPassword({ id: "1", password: "" });
    expect(out.hasPassword).toBe(false);
  });

  it("sets hasPassword:false when password field is missing", () => {
    const out = stripPassword({ id: "1" } as { id: string; password?: string | null });
    expect(out.hasPassword).toBe(false);
  });

  it("preserves all non-password fields", () => {
    const input = { id: "a", slug: "b", title: "c", password: "hash", extra: 42 };
    const out = stripPassword(input);
    expect(out.id).toBe("a");
    expect(out.slug).toBe("b");
    expect(out.title).toBe("c");
    expect((out as typeof out & { extra: number }).extra).toBe(42);
  });
});
