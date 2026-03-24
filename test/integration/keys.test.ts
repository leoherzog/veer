import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import app from "../../src/index";
import { setupAuth } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

async function api(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: JsonBody } = {}
) {
  const init: RequestInit = { method, headers: opts.headers };
  if (opts.body) {
    init.body = JSON.stringify(opts.body);
  }
  return app.request(path, init, env);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API Keys", () => {
  let headers: Record<string, string>;

  beforeAll(async () => {
    const auth = await setupAuth(env);
    headers = auth.headers;
  });

  // -----------------------------------------------------------------------
  // LIST  GET /api/keys
  // -----------------------------------------------------------------------
  describe("GET /api/keys", () => {
    it("returns empty array initially", async () => {
      const auth = await setupAuth(env);
      const res = await api("GET", "/api/keys", { headers: auth.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: unknown[] };
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it("returns created keys without full key value", async () => {
      const auth = await setupAuth(env);
      await api("POST", "/api/keys", {
        headers: auth.headers,
        body: { name: "My Key" },
      });

      const res = await api("GET", "/api/keys", { headers: auth.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; name: string; prefix: string; key?: string }[] };
      expect(json.data).toHaveLength(1);
      expect(json.data[0].name).toBe("My Key");
      expect(json.data[0].prefix).toBeDefined();
      // Full key must NOT be returned in list
      expect(json.data[0].key).toBeUndefined();
    });

    it("returns 401 without auth", async () => {
      const res = await api("GET", "/api/keys", {
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // CREATE  POST /api/keys
  // -----------------------------------------------------------------------
  describe("POST /api/keys", () => {
    it("creates a key and returns expected fields", async () => {
      const res = await api("POST", "/api/keys", {
        headers,
        body: { name: "Test Key" },
      });
      expect(res.status).toBe(201);
      const json = await res.json() as {
        data: { id: string; name: string; prefix: string; key: string; expiresAt: unknown; createdAt: unknown }
      };
      const { id, name, prefix, key, expiresAt, createdAt } = json.data;
      expect(id).toBeTruthy();
      expect(name).toBe("Test Key");
      expect(key).toMatch(/^veer_/);
      expect(prefix).toBe(key.slice(0, 12));
      expect(createdAt).toBeTruthy();
      expect(expiresAt).toBeNull();
    });

    it("rejects empty name with 400", async () => {
      const res = await api("POST", "/api/keys", {
        headers,
        body: { name: "" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing name with 400", async () => {
      const res = await api("POST", "/api/keys", {
        headers,
        body: {},
      });
      expect(res.status).toBe(400);
    });

    it("creates a key with a future expiresAt", async () => {
      const future = new Date(Date.now() + 86400_000).toISOString();
      const res = await api("POST", "/api/keys", {
        headers,
        body: { name: "Expiring Key", expiresAt: future },
      });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { expiresAt: string } };
      expect(json.data.expiresAt).toBeTruthy();
    });

    it("rejects invalid expiresAt string with 400", async () => {
      const res = await api("POST", "/api/keys", {
        headers,
        body: { name: "test", expiresAt: "not-a-date" },
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toBe("Invalid expiresAt date");
    });

    it("rejects request with no body at all with 400", async () => {
      const res = await app.request("/api/keys", {
        method: "POST",
        headers,
      }, env);
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toBe("Invalid JSON body");
    });

    it("rejects expiresAt in the past with 400", async () => {
      const past = new Date(Date.now() - 86400_000).toISOString();
      const res = await api("POST", "/api/keys", {
        headers,
        body: { name: "Expired Key", expiresAt: past },
      });
      expect(res.status).toBe(400);
    });

    it("enforces the 10-key limit", async () => {
      const auth = await setupAuth(env);

      // Create 10 keys
      for (let i = 0; i < 10; i++) {
        const res = await api("POST", "/api/keys", {
          headers: auth.headers,
          body: { name: `Key ${i}` },
        });
        expect(res.status).toBe(201);
      }

      // The 11th key should fail
      const res = await api("POST", "/api/keys", {
        headers: auth.headers,
        body: { name: "Key overflow" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await api("POST", "/api/keys", {
        headers: { "Content-Type": "application/json" },
        body: { name: "Unauth Key" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE  DELETE /api/keys/:id
  // -----------------------------------------------------------------------
  describe("DELETE /api/keys/:id", () => {
    it("deletes own key and returns 204", async () => {
      const auth = await setupAuth(env);
      const createRes = await api("POST", "/api/keys", {
        headers: auth.headers,
        body: { name: "To Delete" },
      });
      const { data } = await createRes.json() as { data: { id: string } };

      const deleteRes = await api("DELETE", `/api/keys/${data.id}`, {
        headers: auth.headers,
      });
      expect(deleteRes.status).toBe(204);
    });

    it("returns 404 for nonexistent key", async () => {
      const res = await api("DELETE", "/api/keys/nonexistent-key-id", {
        headers,
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when deleting another user's key", async () => {
      const otherAuth = await setupAuth(env);
      const createRes = await api("POST", "/api/keys", {
        headers: otherAuth.headers,
        body: { name: "Other User Key" },
      });
      const { data } = await createRes.json() as { data: { id: string } };

      // Try to delete with a different user's auth
      const res = await api("DELETE", `/api/keys/${data.id}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await api("DELETE", "/api/keys/some-id", {
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });
  });
});
