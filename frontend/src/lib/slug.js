/**
 * Client-side mirror of `normalizeSlug()` in `src/services/slug.ts`.
 *
 * Kept in sync so the slug shown in the form is the slug the API stores:
 * percent-decoded, NFC, lowercased. The server normalizes again regardless —
 * this only exists so the user sees the canonical form before submitting.
 */
export function normalizeSlug(input) {
  if (typeof input !== "string") return "";
  let slug = input.trim();
  if (slug.includes("%")) {
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep the raw value — the server rejects the stray % */
    }
  }
  // Case folding can denormalize (U+0130 lowercases to "i" + U+0307), so NFC twice.
  return slug.normalize("NFC").toLowerCase().normalize("NFC");
}
