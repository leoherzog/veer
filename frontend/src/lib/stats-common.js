import { escapeHtml } from "./escape.js";

export const SKELETON = `<wa-skeleton effect="pulse" style="height:200px;"></wa-skeleton>`;

export function noData(message = "No data yet") {
  return `<div class="wa-stack wa-align-items-center wa-color-text-quiet" style="padding:var(--wa-space-2xl);">${escapeHtml(message)}</div>`;
}

/** Fetch JSON for stats components. No toast — callers show cardError instead. */
export async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Request failed");
  return res.json();
}

export function cardError(msg) {
  return `<wa-card>${noData(msg)}</wa-card>`;
}
