/**
 * Theme-aware Chart.js wrapper. Every chart created or registered here is
 * tracked so a `theme-change` event on `document` can re-colour it in place.
 */
import { Chart, registerables } from "chart.js";
import { ChoroplethController, GeoFeature, ColorScale, ProjectionScale } from "chartjs-chart-geo";
Chart.register(...registerables, ChoroplethController, GeoFeature, ColorScale, ProjectionScale);

/**
 * Live charts. A tracked chart is destroyed and untracked once its canvas
 * leaves the document, on the next createChart/registerChart call or theme change.
 */
const liveCharts = new Set();

let cachedColors = null;

/**
 * Theme colors cached until the next theme change. Cheap enough to call from a
 * scriptable Chart.js option, which runs once per data point per draw.
 */
export function themeColors() {
  if (!cachedColors) {
    const style = getComputedStyle(document.documentElement);
    cachedColors = {
      text: style.getPropertyValue("--wa-color-text-normal").trim(),
      subdued: style.getPropertyValue("--wa-color-text-quiet").trim(),
      border: style.getPropertyValue("--wa-color-neutral-border-normal").trim(),
      brand: style.getPropertyValue("--wa-color-brand-fill-loud").trim(),
      fill: style.getPropertyValue("--wa-color-neutral-fill-quiet").trim(),
    };
  }
  return cachedColors;
}

/**
 * Destroy tracked charts whose canvas has left the document. Views replace
 * their markup wholesale, and Chart.js keeps its own reference to an orphaned
 * canvas until told otherwise.
 */
function pruneDetached() {
  for (const chart of liveCharts) {
    if (!chart.canvas) {
      liveCharts.delete(chart);
    } else if (!chart.canvas.isConnected) {
      liveCharts.delete(chart);
      chart.destroy();
    }
  }
}

/** Track a chart built with `new Chart()` directly so it re-themes and is destroyed once detached. */
export function registerChart(chart) {
  pruneDetached();
  liveCharts.add(chart);
  return chart;
}

export function createChart(canvas, type, config) {
  const colors = themeColors();
  const defaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: colors.text } } },
    scales: type !== "doughnut" ? {
      x: { ticks: { color: colors.subdued }, grid: { color: colors.border } },
      y: { ticks: { color: colors.subdued }, grid: { color: colors.border } },
    } : undefined,
  };
  // `plugins` and `scales` merge a level deep, or a chart that sets one option
  // (a tooltip callback, an axis flip) would silently drop the themed defaults.
  const overrides = config.options ?? {};
  return registerChart(new Chart(canvas, {
    type,
    data: config.data,
    options: {
      ...defaults,
      ...overrides,
      plugins: { ...defaults.plugins, ...overrides.plugins },
      scales: mergeScales(defaults.scales, overrides.scales),
    },
  }));
}

function mergeScales(base, overrides) {
  if (!base || !overrides) return base ?? overrides;
  const merged = { ...base };
  for (const [axis, config] of Object.entries(overrides)) {
    merged[axis] = { ...base[axis], ...config };
  }
  return merged;
}

function retheme(chart) {
  const colors = themeColors();
  const options = chart.options;
  if (options.plugins?.legend?.labels) options.plugins.legend.labels.color = colors.text;
  for (const axis of ["x", "y"]) {
    const scale = options.scales?.[axis];
    if (!scale) continue;
    if (scale.ticks) scale.ticks.color = colors.subdued;
    if (scale.grid) scale.grid.color = colors.border;
  }
  chart.update();
}

document.addEventListener("theme-change", () => {
  cachedColors = null;
  pruneDetached();
  for (const chart of liveCharts) retheme(chart);
});
