import { renderLinkForm } from "../components/link-form.js";
import { renderLinkTable } from "../components/link-table.js";
import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { renderCampaignsPanel } from "./campaigns.js";

export function renderDashboard(container, { activeTab = "links" } = {}) {
  container.innerHTML = `
    <div class="dashboard-view">
      <wa-tab-group id="dashboard-tabs">
        <wa-tab panel="links">
          <wa-icon name="link"></wa-icon>
          Links
        </wa-tab>
        <wa-tab panel="campaigns">
          <wa-icon name="bullhorn"></wa-icon>
          Campaigns
        </wa-tab>

        <wa-tab-panel name="links">
          <div class="wa-stack wa-gap-l">
            <div class="wa-split">
              <h1>Your Links</h1>
              <wa-button variant="brand" id="new-link-btn">
                <wa-icon slot="start" name="plus"></wa-icon>
                New Link
              </wa-button>
            </div>
            <div id="create-section" style="display:none;">
              <wa-card>
                <div id="create-form"></div>
              </wa-card>
            </div>
            <wa-input id="search-input" placeholder="Search links..." with-clear>
              <wa-icon slot="start" name="magnifying-glass"></wa-icon>
            </wa-input>
            <div id="links-table"></div>
          </div>
        </wa-tab-panel>

        <wa-tab-panel name="campaigns">
          <div id="campaigns-panel"></div>
        </wa-tab-panel>
      </wa-tab-group>
    </div>
  `;

  // --- Links tab ---
  let currentPage = 1;
  let searchQuery = "";
  let sortBy = "createdAt";
  let sortDir = "desc";

  const createSection = container.querySelector("#create-section");
  const newLinkBtn = container.querySelector("#new-link-btn");
  const searchInput = container.querySelector("#search-input");

  newLinkBtn.addEventListener("click", () => {
    const visible = createSection.style.display !== "none";
    createSection.style.display = visible ? "none" : "block";
    if (!visible) {
      renderLinkForm(container.querySelector("#create-form"), {
        onSuccess: () => {
          createSection.style.display = "none";
          loadLinks();
        },
      });
    }
  });

  let debounceTimer;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = e.target.value;
      currentPage = 1;
      loadLinks();
    }, 300);
  });

  searchInput.addEventListener("wa-clear", () => {
    searchQuery = "";
    currentPage = 1;
    loadLinks();
  });

  async function loadLinks() {
    const params = new URLSearchParams({ page: currentPage, limit: 20, sort: sortBy, dir: sortDir });
    if (searchQuery) params.set("q", searchQuery);

    try {
      const res = await fetch(`/api/links?${params}`);
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) { showToast("Failed to load links", "danger"); return; }
      const { data, pagination } = await res.json();

      renderLinkTable(container.querySelector("#links-table"), {
        links: data,
        pagination,
        sort: { by: sortBy, dir: sortDir },
        onPageChange: (page) => {
          currentPage = page;
          loadLinks();
        },
        onSort: (col, dir) => {
          sortBy = col;
          sortDir = dir;
          currentPage = 1;
          loadLinks();
        },
      });
    } catch {
      showToast("Failed to load links", "danger");
    }
  }

  loadLinks();

  // --- Campaigns tab (lazy load) ---
  let campaignsLoaded = false;
  const tabGroup = container.querySelector("#dashboard-tabs");
  tabGroup.addEventListener("wa-tab-show", (e) => {
    if (e.detail.name === "campaigns" && !campaignsLoaded) {
      campaignsLoaded = true;
      renderCampaignsPanel(container.querySelector("#campaigns-panel"));
    }
    // Sync URL with active tab
    const newPath = e.detail.name === "campaigns" ? "/campaigns" : "/links";
    if (location.pathname !== newPath) {
      history.replaceState(null, "", newPath);
    }
  });

  // Activate the requested tab
  if (activeTab === "campaigns") {
    tabGroup.active = "campaigns";
  }
}
