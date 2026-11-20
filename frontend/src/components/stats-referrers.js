import { CHART_SKELETON, loadStatsCard, statsCard } from "../lib/stats-common.js";
import { clicksData, createChart } from "../lib/chart-helper.js";

const TITLE = "Top Referrers";

/** The card's loading state, for a caller that shows it before the fetch starts. */
export const REFERRERS_SKELETON = statsCard(TITLE, CHART_SKELETON);

export async function renderStatsReferrers(container, linkId, days, signal) {
  const referrers = await loadStatsCard(container, {
    title: TITLE,
    url: `/api/stats/${linkId}/referrers?days=${days}`,
    signal,
    isEmpty: (d) => !d.length,
    empty: "No referrer data yet",
    error: "Failed to load referrer data",
  });
  if (!referrers) return;

  container.innerHTML = statsCard(TITLE, `<div class="wa-frame:landscape"><canvas id="referrers-chart"></canvas></div>`);
  createChart(container.querySelector("#referrers-chart"), "bar", {
    data: clicksData(referrers, "source"),
    options: { indexAxis: "y" },
  });
}
