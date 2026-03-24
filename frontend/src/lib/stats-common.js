export const SKELETON = `<wa-skeleton effect="pulse" style="height:200px;"></wa-skeleton>`;

export function noData(message = "No data yet") {
  return `<div class="text-center text-subdued" style="padding:var(--wa-space-2xl);">${message}</div>`;
}

export async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
