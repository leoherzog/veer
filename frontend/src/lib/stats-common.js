import { escapeHtml } from "./escape.js";

/** Placeholder for a chart. It fills the same `wa-frame:landscape` box the
 *  chart renders into, so the page doesn't jump. */
export const CHART_SKELETON = `<div class="wa-frame:landscape"><wa-skeleton effect="pulse"></wa-skeleton></div>`;

/** Placeholder for a stat tile's value, one line of the value's height. */
export const STAT_SKELETON = `<wa-skeleton effect="pulse" class="stat-skeleton"></wa-skeleton>`;

export function noData(message = "No data yet") {
  return `<div class="wa-stack wa-align-items-center wa-color-text-quiet">${escapeHtml(message)}</div>`;
}

/** Fetch JSON for stats components. No toast; callers fail in place. Rejects on an HTTP error or abort. */
export async function fetchJSON(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("Request failed");
  return res.json();
}

export function statsCard(title, body) {
  return `<wa-card><h3 slot="header">${escapeHtml(title)}</h3>${body}</wa-card>`;
}

/**
 * Fetch one stats card's `data` into `container`, owning its skeleton, empty
 * and error states. Resolves to the data for the caller to chart, or null when
 * the card is already final or `signal` aborted the load.
 * @param {{ title: string, url: string, signal?: AbortSignal, isEmpty: (data: any) => boolean, empty: string, error: string }} opts
 */
export async function loadStatsCard(container, { title, url, signal, isEmpty, empty, error }) {
  container.innerHTML = statsCard(title, CHART_SKELETON);
  let data;
  try {
    ({ data } = await fetchJSON(url, signal));
  } catch {
    if (!signal?.aborted) container.innerHTML = statsCard(title, noData(error));
    return null;
  }
  if (signal?.aborted) return null;
  if (isEmpty(data)) {
    container.innerHTML = statsCard(title, noData(empty));
    return null;
  }
  return data;
}

const regionNames = new Intl.DisplayNames(undefined, { type: "region" });

/** Display name for an ISO 3166-1 alpha-2 code; anything else is returned as-is. */
export function countryName(code) {
  // `of()` throws on a malformed code such as "Unknown".
  return /^[A-Z]{2}$/.test(code) ? regionNames.of(code) : code;
}
