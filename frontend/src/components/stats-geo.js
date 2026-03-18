import { SKELETON, noData, fetchJSON } from "../lib/stats-common.js";

function setBarConfig(chart, items, labelKey) {
  if (!chart) return;
  chart.config = {
    data: {
      labels: items.map((i) => i[labelKey]),
      datasets: [{ label: "Clicks", data: items.map((i) => i.clicks) }],
    },
  };
}

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

    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Geographic</h3>
          ${countries.length ? `<wa-bar-chart id="geo-countries" without-legend x-label="Country" y-label="Clicks" label="Clicks by Country" description="Bar chart showing click distribution across countries"></wa-bar-chart>` : ""}
          ${cities.length ? `<wa-bar-chart id="geo-cities" without-legend x-label="City" y-label="Clicks" label="Clicks by City" description="Bar chart showing click distribution across cities"></wa-bar-chart>` : ""}
        </div>
      </wa-card>
    `;

    setBarConfig(container.querySelector("#geo-countries"), countries, "name");
    setBarConfig(container.querySelector("#geo-cities"), cities, "name");
  } catch {
    container.innerHTML = `<wa-card>${noData("Failed to load geographic data")}</wa-card>`;
  }
}
