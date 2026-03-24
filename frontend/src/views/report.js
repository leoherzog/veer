import { createChart, destroyChart } from "../lib/chart-helper.js";
import { escapeHtml } from "../lib/escape.js";

let chart;

export async function renderReport(container, { token }) {
  if (chart) { destroyChart(chart); chart = null; }

  container.innerHTML = `
    <div class="report-view wa-stack wa-gap-l" style="max-width:48rem;margin:0 auto;padding:var(--wa-space-l);">
      <div id="report-loading" class="wa-stack wa-gap-m wa-align-items-center" style="padding:var(--wa-space-2xl);">
        <wa-spinner class="wa-font-size-2xl"></wa-spinner>
        <p>Loading report…</p>
      </div>
      <div id="report-content" style="display:none;"></div>
      <div id="report-error" style="display:none;"></div>
    </div>
  `;

  try {
    const res = await fetch(`/api/public-report/${encodeURIComponent(token)}`);
    if (!res.ok) {
      container.querySelector("#report-loading").style.display = "none";
      container.querySelector("#report-error").style.display = "block";
      container.querySelector("#report-error").innerHTML = `
        <wa-callout variant="danger">
          <wa-icon slot="icon" name="circle-xmark"></wa-icon>
          This report is not available.
        </wa-callout>
      `;
      return;
    }

    const { data } = await res.json();
    container.querySelector("#report-loading").style.display = "none";
    const content = container.querySelector("#report-content");
    content.style.display = "block";

    content.innerHTML = `
      <div class="wa-stack wa-gap-l">
        <div>
          <h1>${escapeHtml(data.title || data.slug)}</h1>
          ${data.title ? `<p class="wa-color-text-quiet">/${escapeHtml(data.slug)}</p>` : ""}
        </div>
        <wa-card>
          <div class="wa-stack wa-gap-s wa-align-items-center">
            <span class="wa-color-text-quiet">Total Clicks</span>
            <span class="wa-font-size-2xl wa-font-weight-bold">${(data.totalClicks ?? 0).toLocaleString()}</span>
          </div>
        </wa-card>
        ${data.timeseries.labels.length > 0 ? `
          <wa-card>
            <div class="wa-stack wa-gap-s">
              <h3>Last 30 Days</h3>
              <div class="wa-frame:landscape">
                <canvas id="report-chart"></canvas>
              </div>
            </div>
          </wa-card>
        ` : `
          <wa-callout variant="neutral">No click data yet.</wa-callout>
        `}
        <p class="wa-color-text-quiet wa-body-s" style="text-align:center;">
          Powered by Veer
        </p>
      </div>
    `;

    if (data.timeseries.labels.length > 0) {
      const canvas = content.querySelector("#report-chart");
      chart = createChart(canvas, "line", {
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
    const contentEl = container.querySelector("#report-content");
    if (contentEl) contentEl.style.display = "none";
    container.querySelector("#report-loading").style.display = "none";
    container.querySelector("#report-error").style.display = "block";
    container.querySelector("#report-error").innerHTML = `
      <wa-callout variant="danger">
        <wa-icon slot="icon" name="circle-xmark"></wa-icon>
        Failed to load report.
      </wa-callout>
    `;
  }
}
