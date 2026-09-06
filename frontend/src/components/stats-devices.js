import { CHART_SKELETON, noData, fetchJSON, statsCard } from "../lib/stats-common.js";
import { createChart, destroyCharts } from "../lib/chart-helper.js";

export async function renderStatsDevices(container, linkId, days = 30) {
  destroyCharts(container);
  container.innerHTML = statsCard("Devices & Browsers", CHART_SKELETON);

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/devices?days=${days}`);

    const browsers = data.browsers ?? [];
    const os = data.os ?? [];
    const devices = data.devices ?? [];

    const nd = noData();
    container.innerHTML = statsCard("Devices & Browsers", `
      <div class="wa-grid" style="--min-column-size:200px;">
        <div>${browsers.length ? `<div class="wa-frame:square"><canvas id="browsers-chart"></canvas></div>` : nd}</div>
        <div>${os.length ? `<div class="wa-frame:square"><canvas id="os-chart"></canvas></div>` : nd}</div>
        <div>${devices.length ? `<div class="wa-frame:square"><canvas id="device-chart"></canvas></div>` : nd}</div>
      </div>
    `);

    const charts = [];
    container._charts = charts;
    function makeDoughnut(id, items) {
      const canvas = container.querySelector(`#${id}`);
      if (!canvas || !items.length) return;
      charts.push(createChart(canvas, "doughnut", {
        data: {
          labels: items.map((i) => i.name),
          datasets: [{ label: "Clicks", data: items.map((i) => i.clicks) }],
        },
      }));
    }

    makeDoughnut("browsers-chart", browsers);
    makeDoughnut("os-chart", os);
    makeDoughnut("device-chart", devices);
  } catch {
    container.innerHTML = statsCard("Devices & Browsers", noData("Failed to load device data"));
  }
}
