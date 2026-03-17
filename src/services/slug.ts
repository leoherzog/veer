import { SLUG_PATTERN, RESERVED_SLUGS } from "../lib/constants";

export function validateSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug) {
    return { valid: false, error: "Slug is required" };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return { valid: false, error: "Slug must be 1-128 characters: letters, numbers, hyphens, underscores" };
  }
  if (RESERVED_SLUGS.has(slug.toLowerCase())) {
    return { valid: false, error: "This slug is reserved" };
  }
  return { valid: true };
}
