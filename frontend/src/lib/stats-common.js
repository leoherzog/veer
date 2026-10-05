import { escapeHtml } from "./escape.js";

export const SKELETON = `<wa-skeleton effect="pulse" class="stats-skeleton"></wa-skeleton>`;

/** Placeholder for a chart. It fills the same `wa-frame:landscape` box the
 *  chart renders into, so the page doesn't jump. */
export const CHART_SKELETON = `<div class="wa-frame:landscape"><wa-skeleton effect="pulse"></wa-skeleton></div>`;

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
