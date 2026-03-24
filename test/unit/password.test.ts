import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../../src/services/password";

describe("hashPassword", () => {
  it("returns a non-empty string", async () => {
    const hash = await hashPassword("secret");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("returned hash contains exactly one colon (salt:hash format)", async () => {
    const hash = await hashPassword("secret");
    const parts = hash.split(":");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("produces a different hash each time (random salt)", async () => {
    const hash1 = await hashPassword("secret");
    const hash2 = await hashPassword("secret");
    expect(hash1).not.toBe(hash2);
  });

  it("works with an empty string password", async () => {
    const hash = await hashPassword("");
    expect(hash).toContain(":");
  });

  it("works with special characters", async () => {
    const hash = await hashPassword("p@$$w0rd!#%^&*()");
    expect(hash).toContain(":");
  });

  it("works with unicode characters", async () => {
    const hash = await hashPassword("パスワード🔒");
    expect(hash).toContain(":");
  });
});

describe("verifyPassword", () => {
  it("returns true for the correct password", async () => {
    const password = "my-secret-password";
    const hash = await hashPassword(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
  });

  it("returns false for an incorrect password", async () => {
    const hash = await hashPassword("correct-password");
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("returns false for an empty password when hash was of a non-empty one", async () => {
    const hash = await hashPassword("non-empty");
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("returns true for an empty string password hashed as empty", async () => {
    const hash = await hashPassword("");
    await expect(verifyPassword("", hash)).resolves.toBe(true);
  });

  it("is case-sensitive", async () => {
    const hash = await hashPassword("Secret");
    await expect(verifyPassword("secret", hash)).resolves.toBe(false);
    await expect(verifyPassword("SECRET", hash)).resolves.toBe(false);
  });

  it("returns false for a password that differs by whitespace", async () => {
    const hash = await hashPassword("password");
    await expect(verifyPassword(" password", hash)).resolves.toBe(false);
    await expect(verifyPassword("password ", hash)).resolves.toBe(false);
  });

  it("correctly verifies special characters", async () => {
    const password = "p@$$w0rd!#%^&*()";
    const hash = await hashPassword(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword("p@$$w0rd!#%^&*()", hash)).resolves.toBe(true);
    await expect(verifyPassword("p@$$w0rd", hash)).resolves.toBe(false);
  });

  it("correctly verifies unicode passwords", async () => {
    const password = "パスワード🔒";
    const hash = await hashPassword(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword("パスワード", hash)).resolves.toBe(false);
  });

  it("different hashes of the same password both verify correctly", async () => {
    const password = "same-password";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(hash1).not.toBe(hash2); // different salts
    await expect(verifyPassword(password, hash1)).resolves.toBe(true);
    await expect(verifyPassword(password, hash2)).resolves.toBe(true);
  });
});
