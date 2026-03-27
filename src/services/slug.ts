export const SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export const RESERVED_SLUGS = new Set([
  "api", "auth", "login", "logout", "dashboard", "settings", "admin",
  "links", "campaigns", "domains", "health", "favicon.ico", "robots.txt", "sitemap.xml",
]);

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
