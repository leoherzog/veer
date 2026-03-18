import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains("wa-dark");
  return {
    text: style.getPropertyValue("--wa-color-text-default").trim() || (isDark ? "#e5e5e5" : "#333"),
    subdued: style.getPropertyValue("--wa-color-text-subdued").trim() || (isDark ? "#999" : "#666"),
    border: style.getPropertyValue("--wa-color-border-default").trim() || (isDark ? "#444" : "#ddd"),
    brand: style.getPropertyValue("--wa-color-brand-fill-loud").trim() || "#7c3aed",
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
