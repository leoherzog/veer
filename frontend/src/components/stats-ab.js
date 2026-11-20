import { CHART_SKELETON, fetchJSON, noData } from "../lib/stats-common.js";
import { clicksData, createChart } from "../lib/chart-helper.js";

const section = (body) => `<div class="wa-stack wa-gap-s"><h4>Variant Performance</h4>${body}</div>`;

/** The section's loading state, for a caller that shows it before the fetch starts. */
export const AB_SKELETON = section(CHART_SKELETON);

/** Clicks per destination for an A/B link over `days`, failing in place like the other stats cards. */
export async function renderAbStats(container, linkId, days, signal) {
  container.innerHTML = AB_SKELETON;
  let variants;
  try {
    ({ data: variants } = await fetchJSON(`/api/stats/${linkId}/ab?days=${days}`, signal));
  } catch {
    if (!signal?.aborted) container.innerHTML = section(noData("Failed to load variant data"));
    return;
  }
  if (signal?.aborted) return;

  const totalClicks = variants.reduce((sum, v) => sum + v.clicks, 0);
  if (totalClicks === 0) {
    container.innerHTML = section(noData("No variant clicks in this period"));
    return;
  }

  container.innerHTML = section(`<div class="wa-frame:landscape"><canvas id="ab-chart"></canvas></div>`);
  const rows = variants.map((v) => ({ name: v.url.length > 40 ? v.url.slice(0, 37) + "..." : v.url, clicks: v.clicks }));
  createChart(container.querySelector("#ab-chart"), "bar", {
    data: clicksData(rows),
    options: {
      indexAxis: "y",
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.raw} clicks (${((ctx.raw / totalClicks) * 100).toFixed(1)}%)`,
          },
        },
      },
    },
  });
}
