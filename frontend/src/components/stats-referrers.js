import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";

export async function renderStatsReferrers(container, linkId, days = 30) {
  container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Top Referrers</h3>${SKELETON}</div></wa-card>`;

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/referrers?days=${days}`);
    const referrers = Array.isArray(data) ? data : [];

    if (!referrers.length) {
      container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Top Referrers</h3>${noData("No referrer data yet")}</div></wa-card>`;
      return;
    }

    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Top Referrers</h3>
          <wa-bar-chart id="referrers-chart" orientation="horizontal" without-legend
            label="Top Referrers" description="Horizontal bar chart showing top traffic sources">
          </wa-bar-chart>
        </div>
      </wa-card>
    `;

    const chart = container.querySelector("#referrers-chart");
    if (chart) {
      chart.config = {
        data: {
          labels: referrers.map((r) => r.source),
          datasets: [{ label: "Clicks", data: referrers.map((r) => r.clicks) }],
        },
      };
    }
  } catch {
    container.innerHTML = `<wa-card>${noData("Failed to load referrer data")}</wa-card>`;
  }
}
