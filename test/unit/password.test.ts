import { describe, it, expect, beforeAll } from "vitest";
import { hashPassword, verifyPassword } from "../../src/services/password";

const PASSWORD = "Pässwörd 🔒 p@$$!";

describe("hashPassword / verifyPassword", () => {
  let hash: string;

  beforeAll(async () => {
    hash = await hashPassword(PASSWORD);
  });

  it("stores a 16-byte hex salt and a 32-byte hex hash", () => {
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  it.each([
    ["the exact password", PASSWORD, true],
    ["a lowercased copy", PASSWORD.toLowerCase(), false],
    ["an uppercased copy", PASSWORD.toUpperCase(), false],
    ["a leading space", ` ${PASSWORD}`, false],
    ["a trailing space", `${PASSWORD} `, false],
    ["the password without its emoji", PASSWORD.replace("🔒", ""), false],
    ["an empty string", "", false],
  ])("verifies %s as %s", async (_label, attempt, valid) => {
    await expect(verifyPassword(attempt, hash)).resolves.toBe(valid);
  });

  it("salts each hash, and both verify", async () => {
    const other = await hashPassword(PASSWORD);
    expect(other).not.toBe(hash);
    await expect(verifyPassword(PASSWORD, other)).resolves.toBe(true);
  });

  it("verifies an empty password hashed as empty", async () => {
    await expect(verifyPassword("", await hashPassword(""))).resolves.toBe(true);
  });
});
