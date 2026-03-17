export const SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export const RESERVED_SLUGS = new Set([
  "api", "auth", "login", "logout", "dashboard", "settings", "admin",
  "links", "health", "favicon.ico", "robots.txt", "sitemap.xml",
]);
