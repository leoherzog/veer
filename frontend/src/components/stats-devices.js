import { CHART_SKELETON, loadStatsCard, noData, statsCard } from "../lib/stats-common.js";
import { clicksData, createChart } from "../lib/chart-helper.js";

const TITLE = "Devices & Browsers";
const BREAKDOWNS = ["browsers", "os", "devices"];

/** The card's loading state, for a caller that shows it before the fetch starts. */
export const DEVICES_SKELETON = statsCard(TITLE, CHART_SKELETON);

export async function renderStatsDevices(container, linkId, days, signal) {
  const data = await loadStatsCard(container, {
    title: TITLE,
    url: `/api/stats/${linkId}/devices?days=${days}`,
    signal,
    isEmpty: (d) => BREAKDOWNS.every((key) => !d[key].length),
    empty: "No device data yet",
    error: "Failed to load device data",
  });
  if (!data) return;

  container.innerHTML = statsCard(TITLE, `
    <div class="wa-grid" style="--min-column-size:200px;">
      ${BREAKDOWNS.map((key) => `<div>${data[key].length ? `<div class="wa-frame:square"><canvas data-breakdown="${key}"></canvas></div>` : noData()}</div>`).join("")}
    </div>
  `);

  for (const canvas of container.querySelectorAll("canvas[data-breakdown]")) {
    createChart(canvas, "doughnut", { data: clicksData(data[canvas.dataset.breakdown]) });
  }
}
