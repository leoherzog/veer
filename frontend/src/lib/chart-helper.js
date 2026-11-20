/**
 * Chart.js setup: registers every chart type the SPA uses, themes
 * `Chart.defaults` from the Web Awesome colour tokens, and re-colours every
 * live chart when `theme-change` fires on `document`.
 */
import { Chart, registerables } from "chart.js";
import { ChoroplethController, GeoFeature, ColorScale, ProjectionScale } from "chartjs-chart-geo";
Chart.register(...registerables, ChoroplethController, GeoFeature, ColorScale, ProjectionScale);

Chart.defaults.maintainAspectRatio = false;

let probe;

/** `[r, g, b, a]` (0–255) of any CSS colour, read back from one painted pixel. */
function toRgba(color) {
  // An element canvas, not OffscreenCanvas: this runs at bundle load, so a
  // missing API would take down the whole SPA.
  probe ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 })
    .getContext("2d", { willReadFrequently: true });
  probe.clearRect(0, 0, 1, 1);
  // An unparseable colour leaves fillStyle unchanged, so reset it first.
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  return probe.getImageData(0, 0, 1, 1).data;
}

let cachedColors = null;

/**
 * Theme colours as `rgba()` strings, which Chart.js can parse for hover shades
 * whatever format the palette uses. `brandRgb` is "r, g, b" for building
 * `rgba(${brandRgb}, alpha)` ramps. Cached until the next theme change, so it
 * is cheap enough for a scriptable option that runs per data point per draw.
 */
export function themeColors() {
  if (!cachedColors) {
    const style = getComputedStyle(document.documentElement);
    const read = (token) => toRgba(style.getPropertyValue(`--wa-color-${token}`).trim());
    const css = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
    const [r, g, b] = read("brand-fill-loud");
    cachedColors = {
      text: css(read("text-normal")),
      subdued: css(read("text-quiet")),
      border: css(read("neutral-border-normal")),
      surface: css(read("surface-default")),
      fill: css(read("neutral-fill-quiet")),
      brandRgb: `${r}, ${g}, ${b}`,
    };
  }
  return cachedColors;
}

// `Chart.defaults.borderColor` stays unset: changing it turns off the Colors
// plugin that colours every series.
function applyTheme() {
  cachedColors = null;
  const c = themeColors();
  Chart.defaults.color = c.subdued;
  Chart.defaults.plugins.legend.labels.color = c.text;
  Chart.defaults.scale.grid.color = c.border;
  Chart.defaults.scale.border.color = c.border;
  Chart.defaults.elements.arc.borderColor = c.surface;
}

/** Destroy charts whose canvas has left the document; views replace their markup wholesale. */
const pruneDetached = () => Object.values(Chart.instances).forEach((ch) => ch.canvas?.isConnected || ch.destroy());

/** Build a chart on `canvas`. `config` is a Chart.js config without `type`. */
export function createChart(canvas, type, config) {
  pruneDetached();
  return new Chart(canvas, { ...config, type });
}

/** One "Clicks" series from rows shaped `{ [key], clicks }`. */
export function clicksData(items, key = "name") {
  return {
    labels: items.map((item) => item[key]),
    datasets: [{ label: "Clicks", data: items.map((item) => item.clicks) }],
  };
}

applyTheme();

document.addEventListener("theme-change", () => {
  applyTheme();
  pruneDetached();
  Object.values(Chart.instances).forEach((chart) => chart.update());
});
