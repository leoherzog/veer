import { describe, it, expect } from "vitest";
import {
  parseDescription, parseLinkCore, parseOptionalString, parsePositiveInt,
} from "../../src/lib/validators";

const PRIMARY = "short.example";

/** The message of the 400 a parser throws, or null when it does not throw. */
function errorOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("parseLinkCore", () => {
  it("returns the canonical slug and normalized fields", () => {
    expect(parseLinkCore({
      slug: " My-Slug ",
      destinationUrl: "https://example.com/x",
      domainHostname: "Custom.Example",
      redirectType: 301,
      title: "Title",
      ignored: true,
    }, PRIMARY)).toEqual({
      slug: "my-slug",
      destinationUrl: "https://example.com/x",
      domainHostname: "custom.example",
      isInternal: false,
      redirectType: 301,
      title: "Title",
    });
  });

  it("defaults to a 302 with no title on the primary host", () => {
    expect(parseLinkCore({
      slug: "s",
      destinationUrl: "https://example.com",
      domainHostname: PRIMARY,
      redirectType: 307,
      title: "",
    }, PRIMARY)).toMatchObject({ domainHostname: null, redirectType: 302, title: null });
  });

  it.each([
    ["a null entry", null, "Invalid link entry"],
    ["a string entry", "slug", "Invalid link entry"],
    ["a missing slug", { destinationUrl: "https://example.com" }, "Slug is required"],
    ["a non-string slug", { slug: 5, destinationUrl: "https://example.com" }, "Slug is required"],
    ["a reserved slug", { slug: "api", destinationUrl: "https://example.com" }, "This slug is reserved"],
    ["a missing destinationUrl", { slug: "s" }, "destinationUrl is required"],
    ["a non-http destinationUrl", { slug: "s", destinationUrl: "ftp://x" }, "destinationUrl must be an absolute http or https URL"],
    ["a non-string domainHostname", { slug: "s", destinationUrl: "https://example.com", domainHostname: 1 }, "domainHostname must be a string"],
    ["an internal link on a custom domain", { slug: "s", destinationUrl: "https://example.com", domainHostname: "c.example", isInternal: true }, "Internal links are only supported on the default domain"],
    ["a non-string title", { slug: "s", destinationUrl: "https://example.com", title: 7 }, "title must be a string"],
  ])("rejects %s", (_label, raw, message) => {
    expect(errorOf(() => parseLinkCore(raw, PRIMARY))).toBe(message);
  });
});

describe("parsePositiveInt", () => {
  it("floors a positive number", () => {
    expect(parsePositiveInt(3.9, "bad")).toBe(3);
    expect(parsePositiveInt(1, "bad")).toBe(1);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "abc", null, {}])("rejects %j with the given message", (value) => {
    expect(errorOf(() => parsePositiveInt(value, "must be positive"))).toBe("must be positive");
  });
});

describe("parseDescription", () => {
  it("trims, and treats absent, null and blank as null", () => {
    expect(parseDescription("  text  ")).toBe("text");
    for (const raw of [undefined, null, "", "   "]) expect(parseDescription(raw)).toBeNull();
  });

  it("rejects a non-string and anything over 2000 characters", () => {
    expect(errorOf(() => parseDescription(42))).toBe("description must be a string");
    expect(errorOf(() => parseDescription("d".repeat(2001)))).toBe("description must be 2000 characters or fewer");
    expect(parseDescription(`  ${"d".repeat(2000)}  `)).toHaveLength(2000);
  });
});

describe("parseOptionalString", () => {
  it("passes a string through and maps absent, null and empty to null", () => {
    expect(parseOptionalString("x", "field")).toBe("x");
    for (const raw of [undefined, null, ""]) expect(parseOptionalString(raw, "field")).toBeNull();
  });

  it("names the field when the value is not a string", () => {
    expect(errorOf(() => parseOptionalString(1, "ogTitle"))).toBe("ogTitle must be a string");
  });
});
