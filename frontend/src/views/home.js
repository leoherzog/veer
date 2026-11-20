import { getInstanceName } from "../lib/config.js";
import { escapeHtml } from "../lib/escape.js";

/** Signed-out landing page. The "/" route sends a signed-in user to /links before this renders. */
export function renderHome(container) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-l wa-text-center">
      <h1>${escapeHtml(getInstanceName())}</h1>
      <p class="wa-font-size-l">A self-hostable URL shortener built on Cloudflare Workers.</p>
      <p>Shorten links, track clicks, and own your data — deploy to your own Cloudflare account in minutes.</p>
      <wa-button variant="brand" size="l" href="/login" data-link>Get Started</wa-button>
    </div>
  `;
}
