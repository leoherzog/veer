/**
 * Content-Security-Policy strings. `CSP` covers every response; the password
 * gate serves `PASSWORD_GATE_CSP` instead and that page's own policy wins.
 */

const BASE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'sha256-6lEELWNMgHrMCgR7XoJHO/mczPvz9siUa+la3S+ZogI=' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='",
  "style-src 'self' 'unsafe-inline' https://fonts.bunny.net",
  "img-src 'self' data: https:",
  // `data:` — wa-icon fetches the system icon library's data: URIs, so connect-src governs them, not img-src.
  // jsDelivr serves the world-atlas topojson the choropleth fetches at runtime.
  "connect-src 'self' data: https://ka-f.fontawesome.com https://cdn.jsdelivr.net",
  "font-src 'self' https://cdn.jsdelivr.net https://fonts.bunny.net",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
];

/** The SPA submits everything via fetch, so no form may post off-origin. */
export const CSP = [...BASE_DIRECTIVES, "form-action 'self'"].join("; ");

/**
 * The gate's form posts to its own origin but a correct password answers with a
 * 302 to the destination, and Chrome enforces form-action across a submission's
 * whole redirect chain. Naming the destination here would leak it before the
 * password is verified, so the gate carries no form-action at all.
 */
export const PASSWORD_GATE_CSP = BASE_DIRECTIVES.join("; ");
