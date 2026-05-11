import { showToast } from "../components/toast.js";
import { escapeHtml } from "./escape.js";

/** Loading spinner HTML */
export const SPINNER = `<div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-3xl);"><wa-spinner></wa-spinner></div>`;

/** Empty state with icon */
export function emptyState(icon, message) {
  return `<div class="wa-stack wa-gap-m wa-align-items-center" style="padding:var(--wa-space-3xl);">
    <wa-icon name="${icon}" class="wa-font-size-2xl" style="opacity:0.5;"></wa-icon>
    <p class="wa-color-text-quiet">${escapeHtml(message)}</p>
  </div>`;
}

/** Construct short URL from link object */
export function shortUrl(link) {
  return link.domainHostname
    ? `https://${link.domainHostname}/${link.slug}`
    : `${location.origin}/${link.slug}`;
}

/**
 * Fetch wrapper with 401 redirect and error toast.
 * Returns the parsed JSON body on success, or null on failure.
 * Callers destructure the returned object (e.g. { data }, { data, pagination }).
 */
export async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = "/login";
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const variant = err.demoMode ? "warning" : "danger";
    showToast(err.error || err.message || "Request failed", variant);
    return null;
  }
  return res.json();
}

/**
 * Wrap async handler with button loading/disabled guard.
 * Does NOT catch errors — callers are responsible for their own error handling.
 */
export async function withLoadingBtn(btn, fn) {
  btn.loading = true;
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.loading = false;
    btn.disabled = false;
  }
}

/** Debounced search input with wa-clear support. */
export function bindSearchInput(input, onSearch) {
  let timer;
  input.addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => onSearch(e.target.value), 300);
  });
  input.addEventListener("wa-clear", () => {
    clearTimeout(timer);
    onSearch("");
  });
}
