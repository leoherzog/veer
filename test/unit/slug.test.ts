import { describe, it, expect } from "vitest";
import { validateSlug } from "../../src/services/slug";
import { RESERVED_SLUGS } from "../../src/lib/constants";

describe("validateSlug", () => {
  describe("valid slugs", () => {
    it("accepts a simple word", () => {
      expect(validateSlug("hello")).toEqual({ valid: true });
    });

    it("accepts hyphens", () => {
      expect(validateSlug("my-link")).toEqual({ valid: true });
    });

    it("accepts underscores and digits", () => {
      expect(validateSlug("test_123")).toEqual({ valid: true });
    });

    it("accepts a single character", () => {
      expect(validateSlug("A")).toEqual({ valid: true });
    });

    it("accepts a 128-character slug", () => {
      const slug = "a".repeat(128);
      expect(validateSlug(slug)).toEqual({ valid: true });
    });

    it("accepts mixed case", () => {
      expect(validateSlug("MyLink")).toEqual({ valid: true });
    });
  });

  describe("invalid slugs", () => {
    it("rejects empty string", () => {
      const result = validateSlug("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Slug is required");
    });

    it("rejects slugs with spaces", () => {
      const result = validateSlug("my link");
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/1-128 characters/);
    });

    it("rejects special characters", () => {
      for (const slug of ["hello!", "te@st", "foo#bar"]) {
        expect(validateSlug(slug).valid).toBe(false);
      }
    });

    it("rejects slashes", () => {
      expect(validateSlug("a/b").valid).toBe(false);
    });

    it("rejects dots", () => {
      expect(validateSlug("a.b").valid).toBe(false);
    });

    it("rejects slugs over 128 characters", () => {
      const slug = "a".repeat(129);
      const result = validateSlug(slug);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/1-128 characters/);
    });
  });

  describe("reserved slugs", () => {
    // Some reserved slugs contain dots (favicon.ico, robots.txt, sitemap.xml)
    // which fail the pattern check before reaching the reserved check.
    // Only test slugs that match the pattern for the "reserved" error.
    const patternValidReserved = [...RESERVED_SLUGS].filter((s) =>
      /^[a-zA-Z0-9_-]{1,128}$/.test(s)
    );

    it("rejects pattern-valid reserved slugs", () => {
      for (const slug of patternValidReserved) {
        const result = validateSlug(slug);
        expect(result.valid).toBe(false);
        expect(result.error).toBe("This slug is reserved");
      }
    });

    it("rejects reserved slugs with dots via pattern check", () => {
      // favicon.ico, robots.txt, sitemap.xml have dots — rejected by pattern, not reserved check
      for (const slug of ["favicon.ico", "robots.txt", "sitemap.xml"]) {
        expect(RESERVED_SLUGS.has(slug)).toBe(true);
        const result = validateSlug(slug);
        expect(result.valid).toBe(false);
      }
    });

    it("rejects reserved slugs case-insensitively", () => {
      expect(validateSlug("API").error).toBe("This slug is reserved");
      expect(validateSlug("Login").error).toBe("This slug is reserved");
      expect(validateSlug("DASHBOARD").error).toBe("This slug is reserved");
    });
  });

  describe("edge cases", () => {
    it("treats undefined-ish coercion as empty", () => {
      // When called with an empty-ish value that coerces to falsy
      expect(validateSlug(undefined as unknown as string).valid).toBe(false);
      expect(validateSlug(null as unknown as string).valid).toBe(false);
    });
  });
});
