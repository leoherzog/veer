import { env } from "cloudflare:workers";
import { describe, it, expect, vi } from "vitest";
import { app } from "../../src/index";
import { setupAuth, api } from "../helpers";
import { CSP } from "../../src/lib/csp";

describe("App-level concerns", () => {
  // ── Security headers ─────────────────────────────────────────────────

  describe("Security headers", () => {
    it.each(["/api/config", "/nonexistent-page"])("sets the security headers on %s", async (path) => {
      const res = await api("GET", path);

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });

    it("carries the headers on an HTTPException error response", async () => {
      const auth = await setupAuth();
      const res = await api("DELETE", "/api/keys/does-not-exist", { headers: auth.headers });

      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("carries the headers on a 500 from an unhandled error", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      // An unparseable BETTER_AUTH_URL makes getAuth() throw inside the auth
      // middleware, which is the shortest route to the generic 500 handler.
      const res = await api("GET", "/api/me", { env: { ...env, BETTER_AUTH_URL: "not-a-url" } });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("CSP keeps connect-src same-origin and locks down framing and forms", async () => {
      const res = await api("GET", "/api/config");
      const csp = res.headers.get("Content-Security-Policy") ?? "";

      // The choropleth's topojson is served from public/data, not a CDN.
      const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src ")) ?? "";
      expect(connectSrc).toContain("'self'");
      expect(connectSrc).not.toContain("https://cdn.jsdelivr.net");

      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("object-src 'none'");
    });

    it("script-src carries the SHA-256 of every inline script in the SPA shell", async () => {
      const html = await (await env.ASSETS.fetch("http://localhost/index.html")).text();
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(inline.length).toBeGreaterThan(0);

      const scriptSrc = CSP.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
      for (const script of inline) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
        expect(scriptSrc).toContain(`'sha256-${new Uint8Array(digest).toBase64()}'`);
      }
    });
  });

  // ── Body size caps ───────────────────────────────────────────────────

  // These build raw requests: the caps key on the body stream and Content-Length.
  describe("Body size caps", () => {
    it("rejects a streamed body over 10 KB that carries no Content-Length", async () => {
      const chunk = new TextEncoder().encode("x".repeat(6_000));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const res = await app.request("/api/links", { method: "POST", body, duplex: "half" } as RequestInit, env);

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Request body too large" });
    });

    it("rejects a body over 10 KB by its Content-Length", async () => {
      const body = "x".repeat(11_000);
      const res = await app.request("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body,
      }, env);

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Request body too large" });
    });

    it("caps bulk at 100 KB instead of 10 KB", async () => {
      const { headers } = await setupAuth();
      const post = (size: number) => api("POST", "/api/bulk", { headers, body: "x".repeat(size) });

      // A 50 KB body is read in full and reaches the JSON parser.
      const under = await post(50_000);
      expect(under.status).toBe(400);
      expect(await under.json()).toEqual({ error: "Invalid JSON body" });

      expect((await post(100_001)).status).toBe(413);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────

  describe("Error handling", () => {
    it.each(["GET", "POST", "DELETE"])("answers %s on an unknown API path with a JSON 404, not the SPA shell", async (method) => {
      const res = await api(method, "/api/no/such/thing");

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "Not found" });
    });
  });
});
