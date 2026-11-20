import { describe, it, expect } from "vitest";
import { getInstanceName, isDemoMode, isPasskeyEnabled } from "../../src/lib/branding";

/** An env holding only `key`, which is all these readers look at. */
function envWith(key: "INSTANCE_NAME" | "DEMO_MODE" | "PASSKEY_ENABLED", value: string | undefined): Env {
  return { [key]: value } as unknown as Env;
}

describe("getInstanceName", () => {
  it.each([
    [undefined, "Veer"],
    ["", "Veer"],
    ["   ", "Veer"],
    ["Acme Links", "Acme Links"],
    ["  Acme  ", "Acme"],
  ])("maps INSTANCE_NAME %j to %j", (value, name) => {
    expect(getInstanceName(envWith("INSTANCE_NAME", value))).toBe(name);
  });
});

// Both flags are on only for "true", trimmed and case-sensitive.
describe.each([
  ["isDemoMode", "DEMO_MODE", isDemoMode],
  ["isPasskeyEnabled", "PASSKEY_ENABLED", isPasskeyEnabled],
] as const)("%s", (_name, key, read) => {
  it.each([
    ["true", true],
    ["  true  ", true],
    [undefined, false],
    ["", false],
    ["TRUE", false],
    ["false", false],
    ["1", false],
    ["yes", false],
  ])(`maps ${key} %j to %j`, (value, on) => {
    expect(read(envWith(key, value))).toBe(on);
  });
});
