import { CHART_SKELETON, countryName, loadStatsCard, noData, statsCard } from "../lib/stats-common.js";
import { clicksData, createChart, themeColors } from "../lib/chart-helper.js";
import { topojson } from "chartjs-chart-geo";

const TITLE = "Geographic";

/** The card's loading state, for a caller that shows it before the fetch starts. */
export const GEO_SKELETON = statsCard(TITLE, CHART_SKELETON);

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

/**
 * Country outlines for the choropleth, from world-atlas 2.0.2 served with the
 * app. Shared across renders and never aborted; a failure clears the cache so
 * a later render retries.
 */
function loadWorld() {
  if (!worldPromise) {
    worldPromise = fetch("/data/countries-110m.json")
      .then((r) => { if (!r.ok) throw new Error("Failed to fetch map"); return r.json(); })
      .then((topo) => topojson.feature(topo, topo.objects.countries).features)
      .catch((err) => { worldPromise = null; throw err; });
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

/**
 * Geographic card: choropleth plus country and city bars. Every await checks
 * `signal`, so a superseded render never attaches a chart to a canvas that a
 * newer render owns.
 */
export async function renderStatsGeo(container, linkId, days, signal) {
  const data = await loadStatsCard(container, {
    title: TITLE,
    url: `/api/stats/${linkId}/geo?days=${days}`,
    signal,
    isEmpty: (d) => !d.countries.length && !d.cities.length,
    empty: "No geographic data yet",
    error: "Failed to load geographic data",
  });
  if (!data) return;
  const { countries, cities } = data;

  container.innerHTML = statsCard(TITLE, `
    <div class="wa-stack wa-gap-m">
      ${countries.length ? `<div id="geo-map-slot"><div class="wa-frame:landscape"><canvas id="geo-map"></canvas></div></div>` : ""}
      ${countries.length ? `<div class="wa-frame:landscape"><canvas id="geo-countries"></canvas></div>` : ""}
      ${cities.length ? `<div class="wa-frame:landscape"><canvas id="geo-cities"></canvas></div>` : ""}
    </div>
  `);

  if (countries.length) {
    createChart(container.querySelector("#geo-countries"), "bar", {
      data: clicksData(countries.map((c) => ({ name: countryName(c.name), clicks: c.clicks }))),
    });
  }
  if (cities.length) createChart(container.querySelector("#geo-cities"), "bar", { data: clicksData(cities) });
  if (!countries.length) return;

  let features;
  try {
    features = await loadWorld();
  } catch {
    if (!signal?.aborted) container.querySelector("#geo-map-slot").innerHTML = noData("Map unavailable");
    return;
  }
  if (signal?.aborted) return;

  const clickMap = buildClickMap(countries);
  const maxClicks = Math.max(...clickMap.values(), 1);
  createChart(container.querySelector("#geo-map"), "choropleth", {
    data: {
      labels: features.map((f) => f.properties.name),
      datasets: [{
        label: "Clicks",
        data: features.map((f) => ({ feature: f, value: clickMap.get(f.id) || 0 })),
        // Scriptable so the map repaints in the new palette on a theme change.
        backgroundColor: (ctx) => {
          const v = ctx.raw?.value || 0;
          const colors = themeColors();
          if (v === 0) return colors.fill;
          const alpha = 0.15 + Math.min(v / maxClicks, 1) * 0.85;
          return `rgba(${colors.brandRgb}, ${alpha})`;
        },
        borderColor: () => themeColors().border,
        borderWidth: 0.5,
      }],
    },
    options: {
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
        projection: { axis: "x", projection: "equalEarth" },
        color: { axis: "x", display: false },
      },
    },
  });
}
