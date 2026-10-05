import { createChart } from "../lib/chart-helper.js";
import { escapeHtml } from "../lib/escape.js";
import { getInstanceName } from "../lib/config.js";
import { errorCallout, statCard } from "../lib/ui.js";
import { statsCard } from "../lib/stats-common.js";

export async function renderReport(container, { token }) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-m wa-align-items-center" style="padding:var(--wa-space-2xl);">
      <wa-spinner class="wa-font-size-2xl"></wa-spinner>
      <p>Loading report…</p>
    </div>
  `;

  try {
    const res = await fetch(`/api/public-report/${encodeURIComponent(token)}`);
    if (!res.ok) {
      const message = res.status === 429
        ? "Too many requests, try again shortly."
        : "This report is not available.";
      container.innerHTML = errorCallout(message);
      return;
    }

    const { data } = await res.json();
    const hasClicks = data.timeseries.labels.length > 0;

    container.innerHTML = `
      <div class="wa-stack wa-gap-l">
        <div>
          <h1>${escapeHtml(data.title || data.slug)}</h1>
          ${data.title ? `<p class="wa-color-text-quiet">/${escapeHtml(data.slug)}</p>` : ""}
        </div>
        ${statCard("Total Clicks", `<wa-format-number value="${data.totalClicks}"></wa-format-number>`)}
        ${hasClicks
          ? statsCard("Last 30 Days", `<div class="wa-frame:landscape"><canvas id="report-chart"></canvas></div>`)
          : `<wa-callout variant="neutral">No click data yet.</wa-callout>`}
        <p class="wa-color-text-quiet wa-body-s wa-text-center">
          Powered by ${escapeHtml(getInstanceName())}
        </p>
      </div>
    `;

    if (hasClicks) {
      createChart(container.querySelector("#report-chart"), "line", {
        data: {
          labels: data.timeseries.labels,
          datasets: [{
            label: "Clicks",
            data: data.timeseries.clicks,
            fill: true,
          }],
        },
        options: {
          scales: { y: { beginAtZero: true } },
          plugins: { legend: { display: false } },
        },
      });
    }
  } catch (err) {
    console.error("Report load error:", err);
    container.innerHTML = errorCallout("Failed to load report.");
  }
}
