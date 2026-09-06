import { apiFetch } from "../lib/ui.js";
import { createChart, destroyCharts } from "../lib/chart-helper.js";

export async function renderAbStats(container, linkId) {
  destroyCharts(container);
  const result = await apiFetch(`/api/stats/${linkId}/ab`);
  if (!result || !result.data?.length) return;

  const variants = result.data;
  const totalClicks = variants.reduce((sum, v) => sum + v.clicks, 0);
  if (totalClicks === 0) return;

  container.innerHTML = `
    <div class="wa-stack wa-gap-s">
      <h4>Variant Performance</h4>
      <div class="wa-frame:landscape"><canvas id="ab-chart"></canvas></div>
    </div>
  `;

  const canvas = container.querySelector("#ab-chart");
  const labels = variants.map(v => (v.url.length > 40 ? v.url.slice(0, 37) + "..." : v.url));
  const data = variants.map(v => v.clicks);

  container._charts = [createChart(canvas, "bar", {
    data: {
      labels,
      datasets: [{ label: "Clicks", data }],
    },
    options: {
      indexAxis: "y",
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const clicks = ctx.raw;
              const pct = ((clicks / totalClicks) * 100).toFixed(1);
              return `${clicks} clicks (${pct}%)`;
            },
          },
        },
      },
    },
  })];
}
