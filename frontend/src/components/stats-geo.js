import { SKELETON, noData, fetchJSON, cardError } from "../lib/stats-common.js";
import { createChart, destroyChart } from "../lib/chart-helper.js";
import { Chart } from "chart.js";
import { feature } from "topojson-client";

// ISO 3166-1 alpha-2 → numeric mapping for world-atlas feature matching
const A2 = {
  AF:"004",AL:"008",DZ:"012",AS:"016",AD:"020",AO:"024",AG:"028",AR:"032",AM:"051",AU:"036",
  AT:"040",AZ:"031",BS:"044",BH:"048",BD:"050",BB:"052",BY:"112",BE:"056",BZ:"084",BJ:"204",
  BT:"064",BO:"068",BA:"070",BW:"072",BR:"076",BN:"096",BG:"100",BF:"854",BI:"108",KH:"116",
  CM:"120",CA:"124",CV:"132",CF:"140",TD:"148",CL:"152",CN:"156",CO:"170",KM:"174",CG:"178",
  CD:"180",CR:"188",CI:"384",HR:"191",CU:"192",CY:"196",CZ:"203",DK:"208",DJ:"262",DM:"212",
  DO:"214",EC:"218",EG:"818",SV:"222",GQ:"226",ER:"232",EE:"233",ET:"231",SZ:"748",FJ:"242",
  FI:"246",FR:"250",GA:"266",GM:"270",GE:"268",DE:"276",GH:"288",GR:"300",GD:"308",GT:"320",
  GN:"324",GW:"624",GY:"328",HT:"332",HN:"340",HU:"348",IS:"352",IN:"356",ID:"360",IR:"364",
  IQ:"368",IE:"372",IL:"376",IT:"380",JM:"388",JP:"392",JO:"400",KZ:"398",KE:"404",KI:"296",
  KP:"408",KR:"410",KW:"414",KG:"417",LA:"418",LV:"428",LB:"422",LS:"426",LR:"430",LY:"434",
  LI:"438",LT:"440",LU:"442",MK:"807",MG:"450",MW:"454",MY:"458",MV:"462",ML:"466",MT:"470",
  MH:"584",MR:"478",MU:"480",MX:"484",FM:"583",MD:"498",MC:"492",MN:"496",ME:"499",MA:"504",
  MZ:"508",MM:"104",NA:"516",NR:"520",NP:"524",NL:"528",NZ:"554",NI:"558",NE:"562",NG:"566",
  NO:"578",OM:"512",PK:"586",PW:"585",PA:"591",PG:"598",PY:"600",PE:"604",PH:"608",PL:"616",
  PT:"620",QA:"634",RO:"642",RU:"643",RW:"646",KN:"659",LC:"662",VC:"670",WS:"882",SM:"674",
  ST:"678",SA:"682",SN:"686",RS:"688",SC:"690",SL:"694",SG:"702",SK:"703",SI:"705",SB:"090",
  SO:"706",ZA:"710",SS:"728",ES:"724",LK:"144",SD:"729",SR:"740",SE:"752",CH:"756",SY:"760",
  TW:"158",TJ:"762",TZ:"834",TH:"764",TL:"626",TG:"768",TO:"776",TT:"780",TN:"788",TR:"792",
  TM:"795",TV:"798",UG:"800",UA:"804",AE:"784",GB:"826",US:"840",UY:"858",UZ:"860",VU:"548",
  VE:"862",VN:"704",YE:"887",ZM:"894",ZW:"716",XK:"926",PS:"275",EH:"732",GL:"304",NC:"540",
  FK:"238",PR:"630",GF:"254",RE:"638",HK:"344",MO:"446",TF:"260",AQ:"010"
};

let worldPromise = null;

function loadWorld() {
  if (!worldPromise) {
    worldPromise = fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((r) => { if (!r.ok) throw new Error("Failed to fetch map"); return r.json(); })
      .then((topo) => feature(topo, topo.objects.countries).features);
  }
  return worldPromise;
}

function buildClickMap(countries) {
  const map = new Map();
  for (const c of countries) {
    const num = A2[c.name];
    if (num) map.set(num, (map.get(num) || 0) + c.clicks);
  }
  return map;
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

    (container._charts || []).forEach(destroyChart);

    const hasMap = countries.length > 0;
    container.innerHTML = `
      <wa-card>
        <div class="wa-stack wa-gap-m">
          <h3>Geographic</h3>
          ${hasMap ? `<div style="position:relative;height:320px;"><canvas id="geo-map"></canvas></div>` : ""}
          ${countries.length ? `<div class="wa-frame:landscape"><canvas id="geo-countries"></canvas></div>` : ""}
          ${cities.length ? `<div class="wa-frame:landscape"><canvas id="geo-cities"></canvas></div>` : ""}
        </div>
      </wa-card>
    `;

    const charts = [];

    // Choropleth map
    if (hasMap) {
      try {
        const features = await loadWorld();
        const clickMap = buildClickMap(countries);
        const maxClicks = Math.max(...clickMap.values(), 1);

        const mapCanvas = container.querySelector("#geo-map");
        if (mapCanvas) {
          const style = getComputedStyle(document.documentElement);
          const brandColor = style.getPropertyValue("--wa-color-brand-fill-loud").trim() || "#7c3aed";
          const isDark = document.documentElement.classList.contains("wa-dark");
          const bgColor = isDark ? "#1a1a2e" : "#e8ecf1";
          const borderColor = isDark ? "#333" : "#ccc";
          const textColor = style.getPropertyValue("--wa-color-text-normal").trim() || (isDark ? "#e5e5e5" : "#333");

          const chart = new Chart(mapCanvas, {
            type: "choropleth",
            data: {
              labels: features.map((f) => f.properties.name),
              datasets: [{
                label: "Clicks",
                data: features.map((f) => ({
                  feature: f,
                  value: clickMap.get(f.id) || 0,
                })),
                backgroundColor: (ctx) => {
                  const v = ctx.raw?.value || 0;
                  if (v === 0) return bgColor;
                  const intensity = Math.min(v / maxClicks, 1);
                  const alpha = 0.15 + intensity * 0.85;
                  return hexToRgba(brandColor, alpha);
                },
                borderColor,
                borderWidth: 0.5,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              showOutline: true,
              showGraticule: false,
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: (ctx) => {
                      const v = ctx.raw?.value || 0;
                      return v > 0 ? `${ctx.label}: ${v} click${v !== 1 ? "s" : ""}` : `${ctx.label}: No clicks`;
                    },
                  },
                },
              },
              scales: {
                projection: {
                  axis: "x",
                  projection: "equalEarth",
                },
                color: {
                  axis: "x",
                  display: false,
                },
              },
            },
          });
          charts.push(chart);
        }
      } catch {
        // Map failed to load — bar charts below still render
      }
    }

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
    container.innerHTML = cardError("Failed to load geographic data");
  }
}

function hexToRgba(hex, alpha) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
