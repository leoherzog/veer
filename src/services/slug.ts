/**
 * Slug rules
 * ----------
 * A slug is one path segment of a short link, so the allowed character set is
 * RFC 3986 `pchar` minus the characters we cannot round-trip:
 *   - `/ ? #` end the segment (or start the query/fragment);
 *   - `%` starts a percent-escape, and since incoming slugs are percent-decoded
 *     before validation a literal `%` would be ambiguous.
 * Non-ASCII is allowed on purpose: an IRI path segment (RFC 3987 `ucschar`) may
 * hold any Unicode character and browsers percent-encode it on the wire, which
 * is exactly what makes emoji slugs work.
 *
 * Slugs are stored **normalized** (percent-decoded, NFC, lowercased) and every
 * lookup normalizes the incoming slug the same way. That gives case-insensitive
 * resolution (`/Blah` → `/blah`) and case-insensitive uniqueness (once `/blah`
 * exists, `/Blah` collides on the existing unique indexes) without needing a
 * `COLLATE NOCASE` index, which would only fold ASCII anyway.
 *
 * Always go through `validateSlug()` / `normalizeSlug()` — never store or look
 * up a raw user-supplied slug.
 */

/** Max length in Unicode code points. */
export const MAX_SLUG_LENGTH = 128;

/**
 * Max length in UTF-8 bytes. The KV cache key is `{hostname}:{slug}` and KV caps
 * keys at 512 bytes; a hostname is at most 253, so 256 leaves headroom. Only
 * non-ASCII slugs (emoji cost 4 bytes each) can hit this before MAX_SLUG_LENGTH.
 */
export const MAX_SLUG_BYTES = 256;

/**
 * Letters / marks / numbers / pictographs, plus ZWJ and VS16 (needed inside
 * emoji sequences such as 👩‍💻 or ❤️), plus the RFC 3986 sub-delims, `:`, `@`
 * and the unreserved punctuation `- . _ ~`.
 */
export const SLUG_PATTERN =
  /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200D\uFE0F\-._~!$&'()*+,;=:@]+$/u;

/** A slug made only of punctuation/joiners is unusable — require real content. */
const SLUG_SUBSTANCE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/** Team slugs stay ASCII: they are identifiers, not links people type. */
const TEAM_SLUG_PATTERN = /^[a-z0-9_-]{1,128}$/;

export const RESERVED_SLUGS = new Set([
  "api", "auth", "login", "logout", "dashboard", "settings", "admin",
  "links", "campaigns", "domains", "teams", "health",
  "favicon.ico", "robots.txt", "sitemap.xml",
]);

export type SlugCheck =
  | { valid: true; slug: string }
  | { valid: false; error: string };

const encoder = new TextEncoder();

/**
 * Canonical form of a slug: percent-decoded, NFC, lowercased.
 *
 * Applied to both stored slugs and incoming request slugs, so the two always
 * agree. Case folding can denormalize (U+0130 "İ" lowercases to "i" + U+0307),
 * hence the second NFC pass.
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
      /* keep the raw value — the `%` will fail SLUG_PATTERN */
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
  if (!SLUG_PATTERN.test(slug)) {
    return {
      valid: false,
      error: "Slug may only contain letters, numbers, emoji, and - . _ ~ ! $ & ' ( ) * + , ; = : @",
    };
  }
  if (!SLUG_SUBSTANCE.test(slug)) {
    return { valid: false, error: "Slug must contain at least one letter, number, or emoji" };
  }
  if (slug === "." || slug === "..") {
    return { valid: false, error: "This slug is reserved" };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { valid: false, error: "This slug is reserved" };
  }
  return { valid: true, slug };
}

/**
 * Validate a team slug. Same normalization as link slugs (so team slugs are
 * case-insensitively unique too) but a deliberately narrower character set —
 * team slugs are internal identifiers, not links anyone types.
 */
export function validateTeamSlug(input: string): SlugCheck {
  const slug = normalizeSlug(input);
  if (!slug) {
    return { valid: false, error: "Slug is required" };
  }
  if (!TEAM_SLUG_PATTERN.test(slug)) {
    return { valid: false, error: `Slug must be 1-${MAX_SLUG_LENGTH} characters: letters, numbers, hyphens, underscores` };
  }
  return { valid: true, slug };
}
