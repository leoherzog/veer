/**
 * Theme-aware Chart.js wrapper. Every chart created or registered here is
 * tracked so a `theme-change` event on `document` can re-colour it in place.
 */
import { Chart, registerables } from "chart.js";
import { ChoroplethController, GeoFeature, ColorScale, ProjectionScale } from "chartjs-chart-geo";
Chart.register(...registerables, ChoroplethController, GeoFeature, ColorScale, ProjectionScale);

/** Live charts. A destroyed chart drops its canvas, which is how stale entries are pruned. */
const liveCharts = new Set();

let cachedColors = null;

export function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains("wa-dark");
  return {
    text: style.getPropertyValue("--wa-color-text-normal").trim(),
    subdued: style.getPropertyValue("--wa-color-text-quiet").trim(),
    border: style.getPropertyValue("--wa-color-neutral-border-normal").trim(),
    brand: style.getPropertyValue("--wa-color-brand-fill-loud").trim(),
    fill: style.getPropertyValue("--wa-color-neutral-fill-quiet").trim() || (isDark ? "#1a1a2e" : "#e8ecf1"),
  };
}

/**
 * Theme colors cached until the next theme change. Cheap enough to call from a
 * scriptable Chart.js option, which runs once per data point per draw.
 */
export function themeColors() {
  if (!cachedColors) cachedColors = getThemeColors();
  return cachedColors;
}

/**
 * Destroy tracked charts whose canvas has left the document. A view that
 * replaces its markup wholesale orphans the canvas without going through
 * `destroyCharts`, and Chart.js keeps its own reference until told otherwise.
 */
function pruneDetached() {
  for (const chart of liveCharts) {
    if (!chart.canvas) liveCharts.delete(chart);
    else if (!chart.canvas.isConnected) destroyChart(chart);
  }
}

/** Track a chart built with `new Chart()` directly so it re-themes and can be destroyed. */
export function registerChart(chart) {
  pruneDetached();
  if (chart) liveCharts.add(chart);
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

/** Destroy a chart and stop tracking it. Returns null so callers can clear their handle. */
export function destroyChart(instance) {
  if (!instance) return null;
  liveCharts.delete(instance);
  instance.destroy();
  return null;
}

/**
 * Destroy every chart previously rendered into `el` and reset its bookkeeping.
 * Call it before replacing the element's markup, or the old canvases leak.
 */
export function destroyCharts(el) {
  if (!el) return;
  for (const chart of el._charts || []) destroyChart(chart);
  el._charts = [];
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
