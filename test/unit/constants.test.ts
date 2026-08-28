import { describe, it, expect } from "vitest";
import { SLUG_PATTERN, RESERVED_SLUGS, validateSlug } from "../../src/services/slug";

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
      "a.b",          // unreserved punctuation
      "a~b",
      "hello!",       // sub-delim
      "te@st",        // pchar
      "a:b",
      "caf\u00E9",      // IRI: non-ASCII letters
      "\u{1F389}",       // IRI: emoji
    ];

    for (const slug of valid) {
      it(`accepts "${slug.length > 20 ? slug.slice(0, 10) + "\u2026" : slug}"`, () => {
        expect(SLUG_PATTERN.test(slug)).toBe(true);
      });
    }
  });

  describe("rejects invalid slugs", () => {
    const invalid = [
      "",            // empty
      "a b",         // space
      "foo/bar",     // slash
      "foo#bar",     // hash
      "foo?bar",     // question mark
      "foo%bar",     // percent (escapes are decoded before validation)
      "foo\\bar",     // backslash
      "a<b",         // angle bracket
      "a\u0001b",      // control character
    ];

    for (const slug of invalid) {
      it(`rejects ${JSON.stringify(slug)}`, () => {
        expect(SLUG_PATTERN.test(slug)).toBe(false);
      });
    }
  });

  it("enforces minimum length of 1", () => {
    expect(SLUG_PATTERN.test("")).toBe(false);
    expect(SLUG_PATTERN.test("a")).toBe(true);
  });

  it("does not enforce length — validateSlug does", () => {
    // Length is checked in code points and UTF-8 bytes by validateSlug(), so the
    // pattern itself is unbounded. See MAX_SLUG_LENGTH / MAX_SLUG_BYTES.
    expect(SLUG_PATTERN.test("a".repeat(129))).toBe(true);
    expect(validateSlug("a".repeat(129)).valid).toBe(false);
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
