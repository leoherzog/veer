import { escapeHtml } from "../lib/escape.js";
import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";
import { renderStatsDevices } from "./stats-devices.js";
import { renderStatsGeo } from "./stats-geo.js";
import { renderStatsReferrers } from "./stats-referrers.js";

function summaryCard(label, value) {
  return `<wa-card><div style="text-align:center;"><div class="wa-caption-s" style="color:var(--wa-color-neutral-500);">${label}</div><div class="wa-heading-xl">${value}</div></div></wa-card>`;
}

async function loadSummary(container, linkId, days) {
  const el = container.querySelector("#stats-summary");
  el.innerHTML = Array(4).fill(`<wa-card>${SKELETON}</wa-card>`).join("");
  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/summary?days=${days}`);
    el.innerHTML =
      summaryCard("Total Clicks", data.totalClicks ?? 0) +
      summaryCard("Unique UAs", data.uniqueUserAgents ?? 0) +
      summaryCard("Top Country", data.topCountry ? escapeHtml(data.topCountry) : "—") +
      summaryCard("Top Referrer", data.topReferrer ? escapeHtml(data.topReferrer) : "—");
  } catch {
    el.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--wa-color-neutral-500);">Failed to load summary</div>`;
  }
}

async function loadTimeline(container, linkId, days) {
  const wrap = container.querySelector("#timeline-container");
  wrap.innerHTML = SKELETON;

  const period = days <= 1 ? "hour" : "day";
  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/timeseries?period=${period}&days=${days}`);
    const labels = data.labels ?? [];
    const clicks = data.clicks ?? [];

    if (labels.length === 0) {
      wrap.innerHTML = noData("No clicks recorded yet");
      return;
    }

    wrap.innerHTML = `<wa-line-chart id="clicks-timeline" x-label="Date" y-label="Clicks" min="0"
      label="Clicks Over Time" description="Line chart showing clicks over the selected time period"></wa-line-chart>`;

    const chart = wrap.querySelector("#clicks-timeline");
    chart.config = {
      data: {
        labels,
        datasets: [{
          label: "Clicks",
          data: clicks,
          fill: true,
        }],
      },
    };
  } catch {
    wrap.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--wa-color-neutral-500);">Failed to load timeline</div>`;
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
    <div class="stats-section wa-stack wa-gap-l">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h2>Analytics</h2>
        <wa-radio-group id="period-selector" value="30" label="Time period">
          <wa-radio value="1">24h</wa-radio>
          <wa-radio value="7">7d</wa-radio>
          <wa-radio value="30">30d</wa-radio>
          <wa-radio value="90">90d</wa-radio>
        </wa-radio-group>
      </div>

      <div id="stats-summary" class="wa-grid" style="--min-column-size:150px;"></div>

      <wa-card>
        <div id="timeline-container">${SKELETON}</div>
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

  periodGroup.addEventListener("wa-change", async () => {
    const days = parseInt(periodGroup.value, 10);
    await loadAll(container, linkId, days);
  });
}
