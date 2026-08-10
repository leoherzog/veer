import { showToast } from "../components/toast.js";
import { escapeHtml, escapeAttr } from "./escape.js";

/** Loading spinner HTML */
export const SPINNER = `<div class="wa-stack wa-align-items-center"><wa-spinner></wa-spinner></div>`;

/** Empty state with icon */
export function emptyState(icon, message) {
  return `<div class="wa-stack wa-gap-m wa-align-items-center">
    <wa-icon name="${icon}" class="wa-font-size-2xl wa-color-text-quiet"></wa-icon>
    <p class="wa-color-text-quiet">${escapeHtml(message)}</p>
  </div>`;
}

/** Danger callout for a failed load */
export function errorCallout(message) {
  return `<wa-callout variant="danger">
    <wa-icon slot="icon" name="circle-xmark"></wa-icon>
    ${escapeHtml(message)}
  </wa-callout>`;
}

/** Single stat tile: quiet label above a large value. Both are inserted as-is — pre-escape them. */
export function statCard(label, value) {
  return `<wa-card><div class="wa-stack wa-gap-2xs wa-align-items-center"><div class="wa-caption-s wa-color-text-quiet">${label}</div><div class="wa-heading-xl">${value}</div></div></wa-card>`;
}

/**
 * Render a `.link-table` scaffold. `columns` entries are either a plain string
 * or `{ label, sortKey, html }`, where `html` carries a trusted fragment (sort
 * indicators). `rows` are pre-rendered `<tr>` strings.
 */
export function renderTable({ label, columns, rows, tbodyId = "", style = "" }) {
  const headCells = columns.map((c) => {
    if (typeof c === "string") return `<th class="wa-color-text-quiet">${escapeHtml(c)}</th>`;
    const sortAttr = c.sortKey ? ` data-sort="${escapeAttr(c.sortKey)}"` : "";
    return `<th class="wa-color-text-quiet"${sortAttr}>${escapeHtml(c.label ?? "")}${c.html ?? ""}</th>`;
  }).join("");
  return `<table class="link-table" aria-label="${escapeAttr(label)}"${style ? ` style="${escapeAttr(style)}"` : ""}>
      <thead><tr>${headCells}</tr></thead>
      <tbody${tbodyId ? ` id="${escapeAttr(tbodyId)}"` : ""}>${rows.join("")}</tbody>
    </table>`;
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

/**
 * Render pagination controls into `container` and wire them. The wrapper div is
 * required: `wa-pagination` is `display: contents`, so centering has nothing to
 * apply to on the component itself. `container` becomes a stack so its gap —
 * not a margin — separates the pager from the content above it.
 */
export function renderPagination(container, { page, total, limit, onPageChange }) {
  if (total <= limit) return;
  container.classList.add("wa-stack", "wa-gap-m");
  const row = document.createElement("div");
  row.className = "wa-cluster wa-justify-content-center";
  const pager = document.createElement("wa-pagination");
  pager.total = total;
  pager.pageSize = limit;
  pager.page = page;
  pager.format = "compact";
  pager.label = "Pagination";
  pager.addEventListener("wa-page-change", (e) => onPageChange(e.detail.page));
  row.append(pager);
  container.append(row);
}

/**
 * Load a paginated collection into `el` and render it as a `.link-table`,
 * handling the spinner, empty and error states. Returns `el` on success, or
 * null when nothing was rendered.
 */
export async function loadTableSection(el, { url, label, headers, renderRow, empty, error, onPageChange }) {
  el.innerHTML = `<div class="wa-stack wa-align-items-center"><wa-spinner></wa-spinner></div>`;
  try {
    const result = await apiFetch(url);
    if (!result) { el.innerHTML = errorCallout(error); return null; }
    const { data, pagination } = result;
    if (!data.length) { el.innerHTML = `<p class="wa-color-text-quiet">${escapeHtml(empty)}</p>`; return null; }
    el.innerHTML = renderTable({ label, columns: headers, rows: data.map((row) => renderRow(row)) });
    renderPagination(el, {
      page: Number(pagination.page),
      total: Number(pagination.total),
      limit: Number(pagination.limit),
      onPageChange,
    });
    return el;
  } catch {
    el.innerHTML = errorCallout(error);
    return null;
  }
}

/**
 * Refill `select` with the "Me / divider / Teams" option set. Only the
 * `[data-team-opt]` nodes this helper adds are replaced, so any options the
 * caller shipped in the template survive.
 */
export function setTeamOptions(select, teams, { prefix = "", selected = "" } = {}) {
  select.querySelectorAll("[data-team-opt]").forEach((el) => el.remove());
  if (!teams.length) return;
  select.insertAdjacentHTML("beforeend",
    `<wa-divider data-team-opt></wa-divider><small data-team-opt>Teams</small>` +
    teams.map((t) => {
      const v = prefix + t.id;
      return `<wa-option data-team-opt value="${escapeAttr(v)}"${v === selected ? " selected" : ""}>${escapeHtml(t.name)}</wa-option>`;
    }).join(""));
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
