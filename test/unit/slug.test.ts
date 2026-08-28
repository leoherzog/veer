import { describe, it, expect } from "vitest";
import { validateSlug, validateTeamSlug, normalizeSlug, RESERVED_SLUGS } from "../../src/services/slug";

/** Assert a slug is valid and return its canonical form. */
function canonical(input: string): string {
  const result = validateSlug(input);
  expect(result).toMatchObject({ valid: true });
  return (result as { valid: true; slug: string }).slug;
}

describe("normalizeSlug", () => {
  it("lowercases", () => {
    expect(normalizeSlug("Blah")).toBe("blah");
    expect(normalizeSlug("MiXeD-CaSe")).toBe("mixed-case");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSlug("  hello  ")).toBe("hello");
  });

  it("percent-decodes", () => {
    expect(normalizeSlug("caf%C3%A9")).toBe("café");
    expect(normalizeSlug("%F0%9F%8E%89")).toBe("🎉");
  });

  it("leaves a malformed escape alone (validation rejects it)", () => {
    expect(normalizeSlug("100%")).toBe("100%");
    expect(validateSlug("100%").valid).toBe(false);
  });

  it("normalizes to NFC so decomposed and precomposed forms match", () => {
    // "cafe" + combining acute (NFD) must fold onto the precomposed form
    expect(normalizeSlug("cafe\u0301")).toBe(normalizeSlug("caf\u00E9"));
  });

  it("is idempotent", () => {
    for (const s of ["Blah", "caf%C3%A9", " 🎉 ", "A-B_c.d", "İstanbul", "cafe\u0301"]) {
      expect(normalizeSlug(normalizeSlug(s))).toBe(normalizeSlug(s));
    }
  });

  it("returns empty string for non-strings", () => {
    expect(normalizeSlug(undefined as unknown as string)).toBe("");
    expect(normalizeSlug(null as unknown as string)).toBe("");
  });
});

describe("validateSlug", () => {
  describe("valid slugs", () => {
    it("accepts a simple word", () => {
      expect(canonical("hello")).toBe("hello");
    });

    it("accepts hyphens, underscores, digits", () => {
      expect(canonical("my-link")).toBe("my-link");
      expect(canonical("test_123")).toBe("test_123");
    });

    it("accepts a single character", () => {
      expect(canonical("a")).toBe("a");
    });

    it("accepts a 128-character slug", () => {
      expect(canonical("a".repeat(128))).toBe("a".repeat(128));
    });

    it("canonicalizes mixed case", () => {
      expect(canonical("MyLink")).toBe("mylink");
      expect(canonical("BLAH")).toBe("blah");
    });

    it("accepts the RFC 3986 sub-delims, ':' and '@'", () => {
      for (const slug of ["a.b", "a~b", "a!b", "a$b", "a&b", "a'b", "a(b)", "a*b", "a+b", "a,b", "a;b", "a=b", "a:b", "a@b"]) {
        expect(validateSlug(slug).valid).toBe(true);
      }
    });

    it("accepts non-ASCII letters", () => {
      expect(canonical("café")).toBe("café");
      expect(canonical("日本語")).toBe("日本語");
      expect(canonical("ПРИВЕТ")).toBe("привет");
    });

    it("accepts emoji, including multi-codepoint sequences", () => {
      expect(canonical("🎉")).toBe("🎉");
      expect(canonical("party-🎉-time")).toBe("party-🎉-time");
      expect(validateSlug("\u{1F469}\u200D\u{1F4BB}").valid).toBe(true); // ZWJ sequence
      expect(validateSlug("\u2764\uFE0F").valid).toBe(true); // variation selector
    });

    it("accepts a percent-encoded slug and stores it decoded", () => {
      expect(canonical("Caf%C3%89")).toBe("café");
    });
  });

  describe("invalid slugs", () => {
    it("rejects empty and whitespace-only", () => {
      expect(validateSlug("")).toEqual({ valid: false, error: "Slug is required" });
      expect(validateSlug("   ")).toEqual({ valid: false, error: "Slug is required" });
    });

    it("rejects interior whitespace", () => {
      expect(validateSlug("my link").valid).toBe(false);
      expect(validateSlug("my\u00A0link").valid).toBe(false); // non-breaking space
    });

    it("rejects path and query delimiters", () => {
      for (const slug of ["a/b", "a?b", "a#b", "a%b", "a\\b"]) {
        expect(validateSlug(slug).valid).toBe(false);
      }
    });

    it("rejects quotes and angle brackets", () => {
      for (const slug of ['a"b', "a<b", "a>b", "a[b]", "a{b}", "a|b", "a^b", "a`b"]) {
        expect(validateSlug(slug).valid).toBe(false);
      }
    });

    it("rejects control and invisible characters", () => {
      expect(validateSlug("a\u0001b").valid).toBe(false);
      expect(validateSlug("a\u200Bb").valid).toBe(false); // zero-width space
      expect(validateSlug("a\u202Eb").valid).toBe(false); // right-to-left override
    });

    it("rejects slugs with no letter, number, or emoji", () => {
      const result = validateSlug("---");
      expect(result.valid).toBe(false);
      expect(result).toMatchObject({ error: expect.stringContaining("at least one") });
    });

    it("rejects '.' and '..'", () => {
      expect(validateSlug(".").valid).toBe(false);
      expect(validateSlug("..").valid).toBe(false);
    });

    it("rejects slugs over 128 characters", () => {
      const result = validateSlug("a".repeat(129));
      expect(result.valid).toBe(false);
      expect(result).toMatchObject({ error: expect.stringContaining("1-128 characters") });
    });

    it("rejects slugs over 256 UTF-8 bytes even when under 128 characters", () => {
      // 65 four-byte emoji: 65 code points, 260 bytes
      const result = validateSlug("🎉".repeat(65));
      expect(result.valid).toBe(false);
      expect(result).toMatchObject({ error: expect.stringContaining("256 bytes") });
    });
  });

  describe("reserved slugs", () => {
    it("rejects every reserved slug", () => {
      for (const slug of RESERVED_SLUGS) {
        expect(validateSlug(slug)).toEqual({ valid: false, error: "This slug is reserved" });
      }
    });

    it("rejects reserved slugs case-insensitively", () => {
      for (const slug of ["API", "Login", "DASHBOARD", "Favicon.ICO"]) {
        expect(validateSlug(slug)).toEqual({ valid: false, error: "This slug is reserved" });
      }
    });
  });

  describe("case-insensitive collisions", () => {
    it("maps case variants onto the same canonical slug", () => {
      expect(canonical("blah")).toBe(canonical("Blah"));
      expect(canonical("BLAH")).toBe(canonical("bLaH"));
    });
  });
});

describe("validateTeamSlug", () => {
  it("canonicalizes to lowercase", () => {
    expect(validateTeamSlug("My-Team")).toEqual({ valid: true, slug: "my-team" });
  });

  it("accepts letters, numbers, hyphens, underscores", () => {
    expect(validateTeamSlug("team_1-a").valid).toBe(true);
  });

  it("rejects non-ASCII and the punctuation link slugs allow", () => {
    for (const slug of ["café", "🎉", "a.b", "a@b", "a b", ""]) {
      expect(validateTeamSlug(slug).valid).toBe(false);
    }
  });
});
