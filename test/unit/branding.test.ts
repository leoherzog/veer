import { describe, it, expect } from "vitest";
import { getInstanceName, DEFAULT_INSTANCE_NAME } from "../../src/lib/branding";

function envWith(instanceName: string | undefined): Env {
  return { INSTANCE_NAME: instanceName } as unknown as Env;
}

describe("getInstanceName", () => {
  it("falls back to the default when INSTANCE_NAME is undefined", () => {
    expect(getInstanceName(envWith(undefined))).toBe(DEFAULT_INSTANCE_NAME);
  });

  it("falls back to the default when INSTANCE_NAME is an empty string", () => {
    expect(getInstanceName(envWith(""))).toBe(DEFAULT_INSTANCE_NAME);
  });

  it("falls back to the default when INSTANCE_NAME is only whitespace", () => {
    expect(getInstanceName(envWith("   "))).toBe(DEFAULT_INSTANCE_NAME);
  });

  it("returns the configured name when INSTANCE_NAME is set", () => {
    expect(getInstanceName(envWith("Acme Links"))).toBe("Acme Links");
  });

  it("trims surrounding whitespace from a configured name", () => {
    expect(getInstanceName(envWith("  Acme  "))).toBe("Acme");
  });

  it("default is exactly 'Veer'", () => {
    expect(DEFAULT_INSTANCE_NAME).toBe("Veer");
  });
});
