import { escapeHtml } from "./escape.js";

export const SKELETON = `<wa-skeleton effect="pulse" class="stats-skeleton"></wa-skeleton>`;

/** Placeholder for a slot that resolves into a chart. Charts render inside
 *  `wa-frame:landscape` (16/9), so the skeleton claims the same box and the
 *  page doesn't jump when the fetch resolves. */
export const CHART_SKELETON = `<wa-skeleton effect="pulse" class="chart-skeleton"></wa-skeleton>`;

export function noData(message = "No data yet") {
  return `<div class="wa-stack wa-align-items-center wa-color-text-quiet">${escapeHtml(message)}</div>`;
}

/** Fetch JSON for stats components. No toast — callers show an error card instead. */
export async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Request failed");
  return res.json();
}

export function statsCard(title, body) {
  return `<wa-card><h3 slot="header">${escapeHtml(title)}</h3>${body}</wa-card>`;
}
