import { SKELETON, noData, fetchJSON, cardError } from "../lib/stats-common.js";
import { createChart, destroyChart } from "../lib/chart-helper.js";

export async function renderStatsReferrers(container, linkId, days = 30) {
  container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Top Referrers</h3>${SKELETON}</div></wa-card>`;

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/referrers?days=${days}`);
    const referrers = Array.isArray(data) ? data : [];

    if (!referrers.length) {
      container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Top Referrers</h3>${noData("No referrer data yet")}</div></wa-card>`;
      return;
    }

    destroyChart(container._chart);
    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Top Referrers</h3>
          <div class="wa-frame:landscape">
            <canvas id="referrers-chart"></canvas>
          </div>
        </div>
      </wa-card>
    `;

    const canvas = container.querySelector("#referrers-chart");
    if (canvas) {
      container._chart = createChart(canvas, "bar", {
        data: {
          labels: referrers.map((r) => r.source),
          datasets: [{ label: "Clicks", data: referrers.map((r) => r.clicks) }],
        },
        options: { indexAxis: "y" },
      });
    }
  } catch {
    container.innerHTML = cardError("Failed to load referrer data");
  }
}
