export const SKELETON = `<wa-skeleton effect="pulse" style="height:200px;"></wa-skeleton>`;

export const NO_DATA_STYLE = `text-align:center;padding:2rem;color:var(--wa-color-text-subdued);`;

export function noData(message = "No data yet") {
  const el = document.createElement("div");
  el.style.cssText = NO_DATA_STYLE;
  el.textContent = message;
  return el.outerHTML;
}

export async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
