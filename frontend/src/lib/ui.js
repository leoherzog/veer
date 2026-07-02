import { showToast } from "../components/toast.js";
import { escapeHtml } from "./escape.js";

/** Loading spinner HTML */
export const SPINNER = `<div class="wa-stack wa-align-items-center centered-state"><wa-spinner></wa-spinner></div>`;

/** Empty state with icon */
export function emptyState(icon, message) {
  return `<div class="wa-stack wa-gap-m wa-align-items-center centered-state">
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

/**
 * Wire a confirmation dialog. An optional `trigger` opens the dialog on click;
 * the `confirmBtn` runs `onConfirm` inside withLoadingBtn and closes the dialog
 * once it resolves (return `false` to keep it open, e.g. on failure).
 * `onConfirm` owns its own success toast and any navigation/reload.
 */
export function bindConfirmDialog({ dialog, trigger, confirmBtn, onConfirm }) {
  if (trigger) trigger.addEventListener("click", () => { dialog.open = true; });
  confirmBtn.addEventListener("click", () => withLoadingBtn(confirmBtn, async () => {
    const ok = await onConfirm();
    if (ok !== false) dialog.open = false;
  }));
}

/** Render Previous / Page X of Y / Next controls into `container` and wire them. */
export function renderPagination(container, { page, total, limit, onPageChange }) {
  if (total <= limit) return;
  const row = document.createElement("div");
  row.className = "wa-cluster wa-gap-s wa-justify-content-center pagination-row";
  row.innerHTML = `
    <wa-button size="small" variant="neutral" ${page <= 1 ? "disabled" : ""} data-page-prev aria-label="Previous page">Previous</wa-button>
    <span>Page ${page} of ${Math.ceil(total / limit)}</span>
    <wa-button size="small" variant="neutral" ${page * limit >= total ? "disabled" : ""} data-page-next aria-label="Next page">Next</wa-button>
  `;
  row.querySelector("[data-page-prev]").addEventListener("click", () => onPageChange(page - 1));
  row.querySelector("[data-page-next]").addEventListener("click", () => onPageChange(page + 1));
  container.append(row);
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
