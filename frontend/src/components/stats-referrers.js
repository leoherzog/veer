import { CHART_SKELETON, noData, fetchJSON, statsCard } from "../lib/stats-common.js";
import { createChart } from "../lib/chart-helper.js";

export async function renderStatsReferrers(container, linkId, days = 30) {
  container.innerHTML = statsCard("Top Referrers", CHART_SKELETON);

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/referrers?days=${days}`);
    const referrers = data;

    if (!referrers.length) {
      container.innerHTML = statsCard("Top Referrers", noData("No referrer data yet"));
      return;
    }

    container.innerHTML = statsCard("Top Referrers", `
      <div class="wa-frame:landscape">
        <canvas id="referrers-chart"></canvas>
      </div>
    `);

    createChart(container.querySelector("#referrers-chart"), "bar", {
      data: {
        labels: referrers.map((r) => r.source),
        datasets: [{ label: "Clicks", data: referrers.map((r) => r.clicks) }],
      },
      options: { indexAxis: "y" },
    });
  } catch {
    container.innerHTML = statsCard("Top Referrers", noData("Failed to load referrer data"));
  }
}
