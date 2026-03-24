import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "../../src/lib/crypto";

describe("generateApiKey", () => {
  it("returns a string starting with 'veer_'", () => {
    const key = generateApiKey();
    expect(key.startsWith("veer_")).toBe(true);
  });

  it("returns a string of length 48", () => {
    const key = generateApiKey();
    expect(key).toHaveLength(48);
  });

  it("only contains base62 chars after the prefix", () => {
    const key = generateApiKey();
    const suffix = key.slice(5); // remove "veer_"
    expect(suffix).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("produces different keys on each call", () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1).not.toBe(key2);
  });
});

describe("hashApiKey", () => {
  it("returns a 64-character hex string (SHA-256 HMAC)", async () => {
    const hash = await hashApiKey("veer_testkey", "my-secret");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same inputs produce same hash", async () => {
    const hash1 = await hashApiKey("veer_testkey", "my-secret");
    const hash2 = await hashApiKey("veer_testkey", "my-secret");
    expect(hash1).toBe(hash2);
  });

  it("different keys produce different hashes", async () => {
    const hash1 = await hashApiKey("veer_key1", "my-secret");
    const hash2 = await hashApiKey("veer_key2", "my-secret");
    expect(hash1).not.toBe(hash2);
  });

  it("different secrets produce different hashes", async () => {
    const hash1 = await hashApiKey("veer_samekey", "secret-a");
    const hash2 = await hashApiKey("veer_samekey", "secret-b");
    expect(hash1).not.toBe(hash2);
  });
});
