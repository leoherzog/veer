import { Chart, registerables } from "chart.js";
import { ChoroplethController, GeoFeature, ColorScale, ProjectionScale } from "chartjs-chart-geo";
Chart.register(...registerables, ChoroplethController, GeoFeature, ColorScale, ProjectionScale);

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

export function createChart(canvas, type, config) {
  const colors = getThemeColors();
  const defaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: colors.text } } },
    scales: type !== "doughnut" ? {
      x: { ticks: { color: colors.subdued }, grid: { color: colors.border } },
      y: { ticks: { color: colors.subdued }, grid: { color: colors.border } },
    } : undefined,
  };
  return new Chart(canvas, {
    type,
    data: config.data,
    options: { ...defaults, ...config.options },
  });
}

export function destroyChart(instance) {
  if (instance) instance.destroy();
}
