import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";

function setDoughnutConfig(chart, items) {
  if (!chart) return;
  chart.config = {
    data: {
      labels: items.map((i) => i.name),
      datasets: [{ label: "Clicks", data: items.map((i) => i.clicks) }],
    },
  };
}

export async function renderStatsDevices(container, linkId, days = 30) {
  container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Devices &amp; Browsers</h3>${SKELETON}</div></wa-card>`;

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/devices?days=${days}`);

    const browsers = data.browsers ?? [];
    const os = data.os ?? [];
    const devices = data.devices ?? [];

    const nd = noData();
    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Devices &amp; Browsers</h3>
          <div class="wa-grid" style="--min-column-size:200px;">
            <div>${browsers.length ? `<wa-doughnut-chart id="browsers-chart" legend-position="bottom" label="Browser Breakdown" description="Click distribution across browsers"></wa-doughnut-chart>` : nd}</div>
            <div>${os.length ? `<wa-doughnut-chart id="os-chart" legend-position="bottom" label="OS Breakdown" description="Click distribution across operating systems"></wa-doughnut-chart>` : nd}</div>
            <div>${devices.length ? `<wa-doughnut-chart id="device-chart" legend-position="bottom" label="Device Type" description="Click distribution across device types"></wa-doughnut-chart>` : nd}</div>
          </div>
        </div>
      </wa-card>
    `;

    setDoughnutConfig(container.querySelector("#browsers-chart"), browsers);
    setDoughnutConfig(container.querySelector("#os-chart"), os);
    setDoughnutConfig(container.querySelector("#device-chart"), devices);
  } catch {
    container.innerHTML = `<wa-card>${noData("Failed to load device data")}</wa-card>`;
  }
}
