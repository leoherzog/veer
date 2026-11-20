import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { setupAuth, api } from "../helpers";

describe("API Keys", () => {
  let headers: Record<string, string>;

  beforeAll(async () => {
    const auth = await setupAuth();
    headers = auth.headers;
  });

  // -----------------------------------------------------------------------
  // LIST  GET /api/keys
  // -----------------------------------------------------------------------
  describe("GET /api/keys", () => {
    it("returns empty array initially", async () => {
      const auth = await setupAuth();
      const res = await api("GET", "/api/keys", { headers: auth.headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    });

    it("returns created keys without full key value", async () => {
      const auth = await setupAuth();
      const createRes = await api("POST", "/api/keys", {
        headers: auth.headers,
        body: { name: "My Key" },
      });
      const created = await createRes.json() as { data: { key: string } };
      const plaintextKey = created.data.key;
      expect(plaintextKey).toMatch(/^veer_/);

      const res = await api("GET", "/api/keys", { headers: auth.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; name: string; prefix: string; key?: string }[] };
      expect(json.data).toHaveLength(1);
      expect(json.data[0].name).toBe("My Key");
      // The plaintext key must not appear anywhere in the list response...
      expect(JSON.stringify(json)).not.toContain(plaintextKey);
      // ...while the safe, non-secret fields are still present.
      expect(json.data[0].prefix).toBe(plaintextKey.slice(0, 12));
      expect(json.data[0].key).toBeUndefined();
    });

    it("lists the newest key first", async () => {
      const auth = await setupAuth();
      const ids: string[] = [];
      for (const name of ["Older", "Newer"]) {
        const res = await api("POST", "/api/keys", { headers: auth.headers, body: { name } });
        ids.push((await res.json() as { data: { id: string } }).data.id);
      }
      // createdAt has second resolution, so backdate the first key to make the order unambiguous.
      await env.DB.prepare("UPDATE api_keys SET createdAt = 1000 WHERE id = ?").bind(ids[0]).run();

      const res = await api("GET", "/api/keys", { headers: auth.headers });
      const json = await res.json() as { data: { id: string }[] };
      expect(json.data.map(k => k.id)).toEqual([ids[1], ids[0]]);
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

    it("creates a key with a future expiresAt", async () => {
      const future = new Date(Date.now() + 86400_000).toISOString();
      const res = await api("POST", "/api/keys", {
        headers,
        body: { name: "Expiring Key", expiresAt: future },
      });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { expiresAt: string } };
      expect(json.data.expiresAt).toBe(future);
    });

    it.each<[string, unknown, string]>([
      ["no body at all", undefined, "Invalid JSON body"],
      ["a missing name", {}, "name is required"],
      ["an empty name", { name: "" }, "name is required"],
      ["a blank name", { name: "   " }, "name is required"],
      ["a numeric name", { name: 42 }, "name is required"],
      ["an object name", { name: { first: "x" } }, "name is required"],
      ["an array name", { name: ["x"] }, "name is required"],
      ["a name over 200 characters", { name: "x".repeat(201) }, "name must be 200 characters or fewer"],
      ["an unparseable expiresAt", { name: "test", expiresAt: "not-a-date" }, "Invalid expiresAt date"],
      ["an expiresAt in the past", { name: "test", expiresAt: new Date(Date.now() - 86400_000).toISOString() }, "expiresAt must be in the future"],
    ])("rejects %s with 400", async (_label, body, error) => {
      const res = await api("POST", "/api/keys", { headers, body });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    });

    it("enforces the 10-key limit", async () => {
      const auth = await setupAuth();

      for (let i = 0; i < 10; i++) {
        const res = await api("POST", "/api/keys", {
          headers: auth.headers,
          body: { name: `Key ${i}` },
        });
        expect(res.status).toBe(201);
      }

      const res = await api("POST", "/api/keys", {
        headers: auth.headers,
        body: { name: "Key overflow" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Maximum 10 API keys per user" });
    });
  });

  // -----------------------------------------------------------------------
  // DELETE  DELETE /api/keys/:id
  // -----------------------------------------------------------------------
  describe("DELETE /api/keys/:id", () => {
    it("revokes the key: reusing it as a Bearer token returns 401", async () => {
      const auth = await setupAuth();
      const createRes = await api("POST", "/api/keys", {
        headers: auth.headers,
        body: { name: "To Revoke" },
      });
      const { data } = await createRes.json() as { data: { id: string; key: string } };

      const before = await api("GET", "/api/links", {
        headers: { Authorization: `Bearer ${data.key}` },
      });
      expect(before.status).toBe(200);

      const deleteRes = await api("DELETE", `/api/keys/${data.id}`, { headers: auth.headers });
      expect(deleteRes.status).toBe(200);
      expect(await deleteRes.json()).toEqual({ success: true });

      const after = await api("GET", "/api/links", {
        headers: { Authorization: `Bearer ${data.key}` },
      });
      expect(after.status).toBe(401);
    });

    it("returns 404 for nonexistent key", async () => {
      const res = await api("DELETE", "/api/keys/nonexistent-key-id", {
        headers,
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when deleting another user's key", async () => {
      const otherAuth = await setupAuth();
      const createRes = await api("POST", "/api/keys", {
        headers: otherAuth.headers,
        body: { name: "Other User Key" },
      });
      const { data } = await createRes.json() as { data: { id: string } };

      const res = await api("DELETE", `/api/keys/${data.id}`, { headers });
      expect(res.status).toBe(404);
    });
  });
});
