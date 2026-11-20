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
 * or `{ sortKey, html }`, where `html` is a trusted header fragment. `rows` are
 * pre-rendered `<tr>` strings.
 */
export function renderTable({ label, columns, rows }) {
  const headCells = columns.map((c) => {
    if (typeof c === "string") return `<th class="wa-color-text-quiet">${escapeHtml(c)}</th>`;
    const sortAttr = c.sortKey ? ` data-sort="${escapeAttr(c.sortKey)}"` : "";
    return `<th class="wa-color-text-quiet"${sortAttr}>${c.html}</th>`;
  }).join("");
  return `<table class="link-table" aria-label="${escapeAttr(label)}">
      <thead><tr>${headCells}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

/**
 * Short URL for a link, slug percent-encoded so it is safe as an href, copy
 * target and QR payload. The API returns slugs already normalized.
 */
export function shortUrl(link) {
  const slug = encodeURIComponent(link.slug ?? "");
  return link.domainHostname
    ? `https://${link.domainHostname}/${slug}`
    : `${location.origin}/${slug}`;
}

/** True when `/api/me` also answers 401, so a reload boots signed out. */
async function sessionEnded() {
  const res = await fetch("/api/me").catch(() => null);
  return res?.status === 401;
}

/**
 * Fetch wrapper with 401 handling and error toast. Never rejects.
 * Returns the parsed JSON body on success, `{}` for a 2xx with no body, or
 * null on an HTTP, network, parse or abort failure. An abort is silent.
 * @param {RequestInit & { json?: unknown }} opts `json` is sent as a JSON body.
 */
export async function apiFetch(url, { json, ...opts } = {}) {
  if (json !== undefined) {
    opts.headers = new Headers(opts.headers);
    opts.headers.set("Content-Type", "application/json");
    opts.body = JSON.stringify(json);
  }
  try {
    const res = await fetch(url, opts);
    // Reload only once the session has ended: the signed-out boot renders login
    // on this URL, so the OAuth callback returns here, and signed-out views never
    // call apiFetch. A 401 under a live session, such as a Better Auth route in
    // demo mode, would reload forever, so it is toasted like any other error.
    if (res.status === 401 && (await sessionEnded())) {
      location.reload();
      return null;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // The `.catch` above also swallows an abort during the body read.
      if (opts.signal?.aborted) return null;
      const variant = err.demoMode ? "warning" : "danger";
      showToast(err.error || err.message || "Request failed", variant);
      return null;
    }
    // An empty 2xx body still counts as success, so callers can keep testing
    // the result for truthiness.
    const text = await res.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch (err) {
    if (err?.name !== "AbortError") showToast("Request failed", "danger");
    return null;
  }
}

/** `wa-relative-time` markup for `date`, or the `empty` text when there is no date. */
export function relativeTime(date, empty = "—") {
  return date ? `<wa-relative-time date="${escapeAttr(date)}"></wa-relative-time>` : escapeHtml(empty);
}

/** Show a loading/disabled state on `btn` while `fn` runs. Errors propagate to the caller. */
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
 * Wire a confirmation dialog. `confirmBtn` runs `onConfirm` inside
 * withLoadingBtn and closes the dialog once it resolves (return `false` to keep
 * it open, e.g. on failure). `onConfirm` owns its own success toast and any
 * navigation/reload.
 */
export function bindConfirmDialog({ dialog, confirmBtn, onConfirm }) {
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
  if (!(total > limit)) return;
  container.classList.add("wa-stack", "wa-gap-m");
  const row = document.createElement("div");
  row.className = "wa-cluster wa-justify-content-center";
  const pager = document.createElement("wa-pagination");
  pager.total = total;
  pager.pageSize = limit;
  pager.page = page;
  pager.format = "compact";
  pager.addEventListener("wa-page-change", (e) => onPageChange(e.detail.page));
  row.append(pager);
  container.append(row);
}

/** The in-flight load per table section, aborted when a newer load starts. */
const tableLoads = new WeakMap();

/**
 * Load a paginated collection into `el` and render it as a `.link-table`,
 * handling the spinner, empty and error states. An empty page past the first
 * hands the previous page to `onPageChange`. Returns `el` on success, or null
 * when nothing was rendered.
 */
export async function loadTableSection(el, { url, label, headers, renderRow, empty, error, onPageChange }) {
  tableLoads.get(el)?.abort();
  const controller = new AbortController();
  tableLoads.set(el, controller);
  el.innerHTML = SPINNER;
  const result = await apiFetch(url, { signal: controller.signal });
  if (controller.signal.aborted) return null;
  if (!result) { el.innerHTML = errorCallout(error); return null; }
  const { data, pagination } = result;
  if (!data.length && pagination?.page > 1) {
    // Usually the last row of the last page was just deleted.
    const lastPage = Math.ceil(pagination.total / pagination.limit) || 1;
    onPageChange(Math.min(pagination.page - 1, lastPage));
    return null;
  }
  if (!data.length) { el.innerHTML = `<p class="wa-color-text-quiet">${escapeHtml(empty)}</p>`; return null; }
  el.innerHTML = renderTable({ label, columns: headers, rows: data.map((row) => renderRow(row)) });
  renderPagination(el, { ...pagination, onPageChange });
  return el;
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

/** Debounced search input. */
export function bindSearchInput(input, onSearch) {
  let timer;
  input.addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => onSearch(e.target.value), 300);
  });
}
