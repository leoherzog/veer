/**
 * Slug validation and normalization. A slug is one IRI path segment, stored in
 * canonical form, so never store or look up a raw slug. The SPA bundles this
 * module, so it must not import server-only code.
 */

/** Max length in Unicode code points. */
export const MAX_SLUG_LENGTH = 128;

/**
 * Max length in UTF-8 bytes. The KV cache key is `{hostname}:{slug}` and KV caps
 * keys at 512 bytes; a hostname is at most 253, so 256 leaves headroom. Only
 * non-ASCII slugs (emoji cost 4 bytes each) can hit this before MAX_SLUG_LENGTH.
 */
const MAX_SLUG_BYTES = 256;

/**
 * Whole RGI emoji sequences, such as flags, skin tones and tag sequences, whose
 * parts are neither letters nor pictographs. The `#` keycap is left out because
 * its `#` would end the segment.
 */
const EMOJI = /[\p{RGI_Emoji}--\q{#\uFE0F\u20E3}]/gv;

/**
 * Code points allowed outside an emoji sequence: RFC 3986 `pchar` minus `%`,
 * which is ambiguous once escapes are decoded, plus any Unicode letter, mark,
 * number or pictograph; browsers percent-encode those on the wire. ZWJ joins
 * pictographs outside the RGI set, and `\p{M}` covers variation selectors.
 * `/ ? #` stay out because they end the segment.
 */
const SLUG_CHARS = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D\-._~!$&'()*+,;=:@]*$/u;

/**
 * A slug made only of punctuation/joiners is unusable — require real content.
 * This also rules out the `.` and `..` path segments.
 */
const SLUG_SUBSTANCE = /[\p{L}\p{N}\p{Extended_Pictographic}]|[\p{RGI_Emoji}--\q{#\uFE0F\u20E3}]/v;

export const RESERVED_SLUGS = new Set([
  "api", "auth", "login", "logout", "dashboard", "settings", "admin",
  "links", "campaigns", "domains", "teams", "health",
  "favicon.ico", "favicon.svg", "index.html", "robots.txt", "sitemap.xml",
]);

type SlugCheck =
  | { valid: true; slug: string }
  | { valid: false; error: string };

const encoder = new TextEncoder();

/**
 * Canonical form of a slug: percent-decoded, NFC, lowercased. Applied to stored
 * and incoming slugs alike, so the unique indexes enforce case-insensitive
 * uniqueness; COLLATE NOCASE would fold only ASCII. Case folding can denormalize
 * (U+0130 "İ" lowercases to "i" + U+0307), hence the second NFC pass.
 */
export function normalizeSlug(input: string): string {
  if (typeof input !== "string") return "";
  let slug = input.trim();
  if (slug.includes("%")) {
    // Hono already decodes path params; this covers slugs submitted pre-encoded
    // through the API. A malformed escape is left alone and rejected below.
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep the raw value; the `%` fails SLUG_CHARS */
    }
  }
  return slug.normalize("NFC").toLowerCase().normalize("NFC");
}

/** Validate a user-supplied slug and return its canonical form for storage. */
export function validateSlug(input: string): SlugCheck {
  const slug = normalizeSlug(input);
  if (!slug) {
    return { valid: false, error: "Slug is required" };
  }
  if ([...slug].length > MAX_SLUG_LENGTH) {
    return { valid: false, error: `Slug must be 1-${MAX_SLUG_LENGTH} characters` };
  }
  if (encoder.encode(slug).length > MAX_SLUG_BYTES) {
    return { valid: false, error: `Slug is too long (max ${MAX_SLUG_BYTES} bytes once encoded)` };
  }
  // Emoji are stripped before the class check because a single pattern that
  // alternates the class with an emoji sequence backtracks exponentially on a miss.
  if (!SLUG_CHARS.test(slug) && !SLUG_CHARS.test(slug.replace(EMOJI, ""))) {
    return {
      valid: false,
      error: "Slug may only contain letters, numbers, emoji, and - . _ ~ ! $ & ' ( ) * + , ; = : @",
    };
  }
  if (!SLUG_SUBSTANCE.test(slug)) {
    return { valid: false, error: "Slug must contain at least one letter, number, or emoji" };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { valid: false, error: "This slug is reserved" };
  }
  return { valid: true, slug };
}
