import { escapeHtml } from "../lib/escape.js";
import { SKELETON, CHART_SKELETON, noData, fetchJSON } from "../lib/stats-common.js";
import { createChart, destroyChart } from "../lib/chart-helper.js";
import { renderStatsDevices } from "./stats-devices.js";
import { renderStatsGeo } from "./stats-geo.js";
import { renderStatsReferrers } from "./stats-referrers.js";
import { statCard } from "../lib/ui.js";

async function loadSummary(container, linkId, days) {
  const el = container.querySelector("#stats-summary");
  el.innerHTML = Array(4).fill(`<wa-card>${SKELETON}</wa-card>`).join("");
  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/summary?days=${days}`);
    el.innerHTML =
      statCard("Clicks", data.totalClicks ?? 0) +
      statCard("Unique UAs", data.uniqueUserAgents ?? 0) +
      statCard("Top Country", data.topCountry ? escapeHtml(data.topCountry) : "—") +
      statCard("Top Referrer", data.topReferrer ? escapeHtml(data.topReferrer) : "—");
  } catch {
    el.innerHTML = `<div class="wa-span-grid wa-stack wa-align-items-center wa-color-text-quiet">Failed to load summary</div>`;
  }
}

let timelineChart;

async function loadTimeline(container, linkId, days) {
  const wrap = container.querySelector("#timeline-container");
  wrap.innerHTML = CHART_SKELETON;

  const period = days <= 1 ? "hour" : "day";
  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/timeseries?period=${period}&days=${days}`);
    const labels = data.labels ?? [];
    const clicks = data.clicks ?? [];

    if (labels.length === 0) {
      wrap.innerHTML = noData("No clicks recorded yet");
      return;
    }

    destroyChart(timelineChart);
    wrap.innerHTML = `<div class="wa-frame:landscape"><canvas id="clicks-timeline"></canvas></div>`;
    const canvas = wrap.querySelector("#clicks-timeline");
    timelineChart = createChart(canvas, "line", {
      data: {
        labels,
        datasets: [{
          label: "Clicks",
          data: clicks,
          fill: true,
        }],
      },
    });
  } catch {
    wrap.innerHTML = noData("Failed to load timeline");
  }
}

async function loadAll(container, linkId, days) {
  await Promise.allSettled([
    loadSummary(container, linkId, days),
    loadTimeline(container, linkId, days),
    renderStatsDevices(container.querySelector("#devices-container"), linkId, days),
    renderStatsGeo(container.querySelector("#geo-container"), linkId, days),
    renderStatsReferrers(container.querySelector("#referrers-container"), linkId, days),
  ]);
}

export async function renderStatsCharts(container, linkId) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <wa-radio-group id="period-selector" value="30" label="Time period" orientation="horizontal">
        <wa-radio value="1">24h</wa-radio>
        <wa-radio value="7">7d</wa-radio>
        <wa-radio value="30">30d</wa-radio>
        <wa-radio value="90">90d</wa-radio>
      </wa-radio-group>

      <div id="stats-summary" class="wa-grid" style="--min-column-size:150px;"></div>

      <wa-card>
        <div id="timeline-container">${CHART_SKELETON}</div>
      </wa-card>

      <div class="wa-grid" style="--min-column-size:300px;">
        <div id="devices-container"></div>
        <div id="geo-container"></div>
      </div>

      <div id="referrers-container"></div>
    </div>
  `;

  const periodGroup = container.querySelector("#period-selector");

  await loadAll(container, linkId, 30);

  periodGroup.addEventListener("change", async () => {
    const days = parseInt(periodGroup.value, 10);
    await loadAll(container, linkId, days);
  });
}
