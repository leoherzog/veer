import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";
import { createChart, destroyChart } from "../lib/chart-helper.js";

export async function renderStatsGeo(container, linkId, days = 30) {
  container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Geographic</h3>${SKELETON}</div></wa-card>`;

  try {
    const { data } = await fetchJSON(`/api/stats/${linkId}/geo?days=${days}`);

    const countries = data.countries ?? [];
    const cities = data.cities ?? [];

    if (!countries.length && !cities.length) {
      container.innerHTML = `<wa-card><div class="wa-stack wa-gap-m"><h3>Geographic</h3>${noData("No geographic data yet")}</div></wa-card>`;
      return;
    }

    (container._charts || []).forEach(destroyChart);

    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Geographic</h3>
          ${countries.length ? `<canvas id="geo-countries" style="height:200px;"></canvas>` : ""}
          ${cities.length ? `<canvas id="geo-cities" style="height:200px;"></canvas>` : ""}
        </div>
      </wa-card>
    `;

    const charts = [];
    function makeBar(id, items, labelKey) {
      const canvas = container.querySelector(`#${id}`);
      if (!canvas || !items.length) return;
      charts.push(createChart(canvas, "bar", {
        data: {
          labels: items.map((i) => i[labelKey]),
          datasets: [{ label: "Clicks", data: items.map((i) => i.clicks) }],
        },
      }));
    }

    makeBar("geo-countries", countries, "name");
    makeBar("geo-cities", cities, "name");
    container._charts = charts;
  } catch {
    container.innerHTML = `<wa-card>${noData("Failed to load geographic data")}</wa-card>`;
  }
}
