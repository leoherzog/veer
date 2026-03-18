import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";
import { createChart, destroyChart } from "../lib/chart-helper.js";

let charts = [];

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

    charts.forEach(destroyChart);
    charts = [];

    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Geographic</h3>
          ${countries.length ? `<canvas id="geo-countries" style="height:200px;"></canvas>` : ""}
          ${cities.length ? `<canvas id="geo-cities" style="height:200px;"></canvas>` : ""}
        </div>
      </wa-card>
    `;

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
  } catch {
    container.innerHTML = `<wa-card>${noData("Failed to load geographic data")}</wa-card>`;
  }
}
