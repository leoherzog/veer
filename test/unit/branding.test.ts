import { describe, it, expect } from "vitest";
import { getInstanceName, isDemoMode, DEFAULT_INSTANCE_NAME } from "../../src/lib/branding";

function envWith(instanceName: string | undefined): Env {
  return { INSTANCE_NAME: instanceName } as unknown as Env;
}

function envWithDemo(demoMode: string | undefined): Env {
  return { DEMO_MODE: demoMode } as unknown as Env;
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

describe("isDemoMode", () => {
  it("returns true when DEMO_MODE is 'true'", () => {
    expect(isDemoMode(envWithDemo("true"))).toBe(true);
  });

  it("trims whitespace around 'true'", () => {
    expect(isDemoMode(envWithDemo("  true  "))).toBe(true);
  });

  it("returns false when DEMO_MODE is an empty string", () => {
    expect(isDemoMode(envWithDemo(""))).toBe(false);
  });

  it("returns false when DEMO_MODE is undefined", () => {
    expect(isDemoMode(envWithDemo(undefined))).toBe(false);
  });

  it("is case-sensitive — 'TRUE' returns false", () => {
    expect(isDemoMode(envWithDemo("TRUE"))).toBe(false);
  });

  it("returns false for unrelated values", () => {
    expect(isDemoMode(envWithDemo("false"))).toBe(false);
    expect(isDemoMode(envWithDemo("1"))).toBe(false);
    expect(isDemoMode(envWithDemo("yes"))).toBe(false);
  });
});
