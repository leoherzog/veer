import { escapeHtml } from "../lib/escape.js";
import { CHART_SKELETON, STAT_SKELETON, countryName, noData, fetchJSON } from "../lib/stats-common.js";
import { createChart } from "../lib/chart-helper.js";
import { AB_SKELETON, renderAbStats } from "./stats-ab.js";
import { DEVICES_SKELETON, renderStatsDevices } from "./stats-devices.js";
import { GEO_SKELETON, renderStatsGeo } from "./stats-geo.js";
import { REFERRERS_SKELETON, renderStatsReferrers } from "./stats-referrers.js";
import { statCard } from "../lib/ui.js";

const STAT_LABELS = ["Clicks", "Unique UAs", "Top Country", "Top Referrer"];

const DETAIL_SKELETON = `
  <div class="wa-stack wa-gap-l">
    <div class="wa-grid" style="--min-column-size:300px;">
      <div id="devices-container">${DEVICES_SKELETON}</div>
      <div id="geo-container">${GEO_SKELETON}</div>
    </div>
    <div id="referrers-container">${REFERRERS_SKELETON}</div>
  </div>
`;

const FALLBACK_NOTICE = `
  <wa-callout id="stats-fallback" variant="neutral">
    <wa-icon slot="icon" name="circle-info"></wa-icon>
    Detailed analytics are unavailable. Totals and the timeline come from daily counts, so visitors, devices, locations and referrers are not shown.
  </wa-callout>
`;

const formatNumber = (n) => `<wa-format-number value="${Number(n) || 0}"></wa-format-number>`;

/** Fill the stat tiles. Resolves to the summary response, or null on failure or abort. */
async function loadSummary(container, linkId, days, signal) {
  const el = container.querySelector("#stats-summary");
  el.innerHTML = STAT_LABELS.map((label) => statCard(label, STAT_SKELETON)).join("");
  let summary;
  try {
    summary = await fetchJSON(`/api/stats/${linkId}/summary?days=${days}`, signal);
  } catch {
    if (!signal.aborted) el.innerHTML = `<div class="wa-span-grid wa-stack wa-align-items-center wa-color-text-quiet">Failed to load summary</div>`;
    return null;
  }
  if (signal.aborted) return null;
  const { data, fallback } = summary;
  const [clicks, unique, country, referrer] = STAT_LABELS;
  el.innerHTML =
    statCard(clicks, formatNumber(data.totalClicks)) +
    statCard(unique, fallback ? "—" : formatNumber(data.uniqueUserAgents)) +
    statCard(country, data.topCountry ? escapeHtml(countryName(data.topCountry)) : "—") +
    statCard(referrer, data.topReferrer ? escapeHtml(data.topReferrer) : "—");
  return summary;
}

async function loadTimeline(container, linkId, days, signal) {
  const wrap = container.querySelector("#timeline-container");
  wrap.innerHTML = CHART_SKELETON;

  const period = days <= 1 ? "hour" : "day";
  let data;
  try {
    ({ data } = await fetchJSON(`/api/stats/${linkId}/timeseries?period=${period}&days=${days}`, signal));
  } catch {
    if (!signal.aborted) wrap.innerHTML = noData("Failed to load timeline");
    return;
  }
  if (signal.aborted) return;
  const { labels, clicks } = data;

  if (labels.length === 0) {
    wrap.innerHTML = noData("No clicks recorded yet");
    return;
  }

  wrap.innerHTML = `<div class="wa-frame:landscape"><canvas id="clicks-timeline"></canvas></div>`;
  createChart(wrap.querySelector("#clicks-timeline"), "line", {
    data: { labels, datasets: [{ label: "Clicks", data: clicks, fill: true }] },
  });
}

/**
 * Load every stats section for `days`. The breakdown cards wait for the
 * summary, because a `fallback` summary means Analytics Engine is unreachable
 * and they would come back empty.
 */
async function loadAll(container, linkId, days, signal, abContainer) {
  const detail = container.querySelector("#stats-detail");
  // Skeletons replace the previous period's breakdowns at once. A fallback
  // notice stays up instead, since the next period most likely falls back too.
  if (!detail.querySelector("#stats-fallback")) {
    detail.innerHTML = DETAIL_SKELETON;
    if (abContainer) abContainer.innerHTML = AB_SKELETON;
  }
  loadTimeline(container, linkId, days, signal);
  const summary = await loadSummary(container, linkId, days, signal);
  if (signal.aborted) return;

  if (summary?.fallback) {
    detail.innerHTML = FALLBACK_NOTICE;
    abContainer?.replaceChildren();
    return;
  }
  if (!detail.querySelector("#devices-container")) detail.innerHTML = DETAIL_SKELETON;
  renderStatsDevices(detail.querySelector("#devices-container"), linkId, days, signal);
  renderStatsGeo(detail.querySelector("#geo-container"), linkId, days, signal);
  renderStatsReferrers(detail.querySelector("#referrers-container"), linkId, days, signal);
  if (abContainer) renderAbStats(abContainer, linkId, days, signal);
}

/**
 * Stats for one link with a period selector. `abContainer`, when given,
 * receives the A/B variant chart for the same period.
 */
export function renderStatsCharts(container, linkId, { abContainer } = {}) {
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
        <div id="timeline-container"></div>
      </wa-card>

      <div id="stats-detail"></div>
    </div>
  `;

  let controller;
  const load = (days) => {
    controller?.abort();
    controller = new AbortController();
    loadAll(container, linkId, days, controller.signal, abContainer);
  };

  const periodGroup = container.querySelector("#period-selector");
  periodGroup.addEventListener("change", () => load(parseInt(periodGroup.value, 10)));
  load(30);
}
