import { describe, it, expect } from "vitest";
import { SLUG_PATTERN, RESERVED_SLUGS } from "../../src/services/slug";

describe("SLUG_PATTERN", () => {
  it("is a RegExp", () => {
    expect(SLUG_PATTERN).toBeInstanceOf(RegExp);
  });

  describe("matches valid slugs", () => {
    const valid = [
      "a",
      "abc",
      "my-link",
      "my_link",
      "abc123",
      "CamelCase",
      "UPPER",
      "lower",
      "a".repeat(128),
      "a-b_c-123",
    ];

    for (const slug of valid) {
      it(`accepts "${slug.length > 20 ? slug.slice(0, 10) + "…" : slug}"`, () => {
        expect(SLUG_PATTERN.test(slug)).toBe(true);
      });
    }
  });

  describe("rejects invalid slugs", () => {
    const invalid = [
      "",            // empty
      "a b",         // space
      "hello!",      // exclamation
      "foo/bar",     // slash
      "a.b",         // dot
      "te@st",       // at-sign
      "foo#bar",     // hash
      "a".repeat(129), // too long
    ];

    for (const slug of invalid) {
      it(`rejects "${slug.length > 20 ? slug.slice(0, 10) + "…(len=" + slug.length + ")" : slug}"`, () => {
        expect(SLUG_PATTERN.test(slug)).toBe(false);
      });
    }
  });

  it("enforces minimum length of 1", () => {
    expect(SLUG_PATTERN.test("")).toBe(false);
    expect(SLUG_PATTERN.test("a")).toBe(true);
  });

  it("enforces maximum length of 128", () => {
    expect(SLUG_PATTERN.test("a".repeat(128))).toBe(true);
    expect(SLUG_PATTERN.test("a".repeat(129))).toBe(false);
  });
});

describe("RESERVED_SLUGS", () => {
  it("is a Set", () => {
    expect(RESERVED_SLUGS).toBeInstanceOf(Set);
  });

  it("is non-empty", () => {
    expect(RESERVED_SLUGS.size).toBeGreaterThan(0);
  });

  it("contains expected route-level slugs", () => {
    const mustReserve = ["api", "auth", "login", "logout", "dashboard", "settings", "admin"];
    for (const slug of mustReserve) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });

  it("contains well-known static file paths", () => {
    expect(RESERVED_SLUGS.has("favicon.ico")).toBe(true);
    expect(RESERVED_SLUGS.has("robots.txt")).toBe(true);
    expect(RESERVED_SLUGS.has("sitemap.xml")).toBe(true);
  });

  it("contains only strings", () => {
    for (const entry of RESERVED_SLUGS) {
      expect(typeof entry).toBe("string");
    }
  });

  it("does not contain empty string", () => {
    expect(RESERVED_SLUGS.has("")).toBe(false);
  });

  it("all entries are lowercase (consistent casing for case-insensitive lookup)", () => {
    for (const entry of RESERVED_SLUGS) {
      expect(entry).toBe(entry.toLowerCase());
    }
  });
});
