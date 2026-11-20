import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "../../src/lib/crypto";

describe("generateApiKey", () => {
  it("returns 'veer_' plus 43 base62 characters", () => {
    expect(generateApiKey()).toMatch(/^veer_[A-Za-z0-9]{43}$/);
  });

  it("produces different keys on each call", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("hashApiKey", () => {
  it("is HMAC-SHA256 of the key under the secret, in lowercase hex (RFC 4231 test case 2)", async () => {
    expect(await hashApiKey("what do ya want for nothing?", "Jefe"))
      .toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("depends on the secret", async () => {
    expect(await hashApiKey("veer_samekey", "secret-a")).not.toBe(await hashApiKey("veer_samekey", "secret-b"));
  });
});
