import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { app } from "../../src/index";
import { setupAuth, mockExecutionCtx } from "../helpers";

describe("App-level concerns", () => {
  // ── Security headers ─────────────────────────────────────────────────

  describe("Security headers", () => {
    it.each(["/api/config", "/nonexistent-page"])("sets the security headers on %s", async (path) => {
      const res = await app.request(path, {}, env);

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });

    it("carries the headers on an HTTPException error response", async () => {
      const auth = await setupAuth();
      const res = await app.request("/api/keys/does-not-exist", {
        method: "DELETE",
        headers: auth.headers,
      }, env, mockExecutionCtx());

      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("carries the headers on a 500 from an unhandled error", async () => {
      // An unparseable BETTER_AUTH_URL makes getAuth() throw inside the auth
      // middleware, which is the shortest route to the generic 500 handler.
      const brokenEnv = { ...env, BETTER_AUTH_URL: "not-a-url" };
      const res = await app.request("/api/me", {}, brokenEnv, mockExecutionCtx());

      expect(res.status).toBe(500);
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("CSP allows the choropleth's topojson source and locks down framing and forms", async () => {
      const res = await app.request("/api/config", {}, env);
      const csp = res.headers.get("Content-Security-Policy") ?? "";

      const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src ")) ?? "";
      expect(connectSrc).toContain("https://cdn.jsdelivr.net");

      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("object-src 'none'");
    });
  });

  // ── Body size caps ───────────────────────────────────────────────────

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

    it("caps bulk at 100 KB instead of 10 KB", async () => {
      const post = (size: number) => app.request("/api/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(size),
      }, env, mockExecutionCtx());

      expect((await post(50_000)).status).not.toBe(413);
      expect((await post(100_001)).status).toBe(413);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────

  describe("Error handling", () => {
    it("an unknown API path returns a JSON 404 for every method, not the SPA shell", async () => {
      for (const method of ["GET", "POST", "DELETE"]) {
        const res = await app.request("/api/no/such/thing", { method }, env, mockExecutionCtx());
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await res.json()).toEqual({ error: "Not found" });
      }
    });
  });
});
