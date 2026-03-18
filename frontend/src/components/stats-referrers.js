import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";
import { createChart, destroyChart } from "../lib/chart-helper.js";

let chart;

export async function renderStatsReferrers(container, linkId, days = 30) {
  container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Top Referrers</h3>${SKELETON}</div></wa-card>`;

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/referrers?days=${days}`);
    const referrers = Array.isArray(data) ? data : [];

    if (!referrers.length) {
      container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Top Referrers</h3>${noData("No referrer data yet")}</div></wa-card>`;
      return;
    }

    destroyChart(chart);
    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Top Referrers</h3>
          <canvas id="referrers-chart" style="height:200px;"></canvas>
        </div>
      </wa-card>
    `;

    const canvas = container.querySelector("#referrers-chart");
    if (canvas) {
      chart = createChart(canvas, "bar", {
        data: {
          labels: referrers.map((r) => r.source),
          datasets: [{ label: "Clicks", data: referrers.map((r) => r.clicks) }],
        },
        options: { indexAxis: "y" },
      });
    }
  } catch {
    container.innerHTML = `<wa-card>${noData("Failed to load referrer data")}</wa-card>`;
  }
}
