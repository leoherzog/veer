import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";
import { createChart, destroyChart } from "../lib/chart-helper.js";

export async function renderStatsDevices(container, linkId, days = 30) {
  container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Devices &amp; Browsers</h3>${SKELETON}</div></wa-card>`;

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/devices?days=${days}`);

    const browsers = data.browsers ?? [];
    const os = data.os ?? [];
    const devices = data.devices ?? [];

    const nd = noData();
    (container._charts || []).forEach(destroyChart);

    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Devices &amp; Browsers</h3>
          <div class="wa-grid" style="--min-column-size:200px;">
            <div>${browsers.length ? `<canvas id="browsers-chart" style="height:200px;"></canvas>` : nd}</div>
            <div>${os.length ? `<canvas id="os-chart" style="height:200px;"></canvas>` : nd}</div>
            <div>${devices.length ? `<canvas id="device-chart" style="height:200px;"></canvas>` : nd}</div>
          </div>
        </div>
      </wa-card>
    `;

    const charts = [];
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
    container._charts = charts;
  } catch {
    container.innerHTML = `<wa-card>${noData("Failed to load device data")}</wa-card>`;
  }
}
