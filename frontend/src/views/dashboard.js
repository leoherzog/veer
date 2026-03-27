import { renderLinkForm } from "../components/link-form.js";
import { renderLinkTable } from "../components/link-table.js";
import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { renderCampaignsPanel } from "./campaigns.js";
import { renderTeamsPanel } from "./teams.js";
import { renderTeamDetail } from "./team-detail.js";
import { escapeHtml } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, bindSearchInput } from "../lib/ui.js";

export function renderDashboard(container, { activeTab = "links", teamId = null } = {}) {
  let userTeams = [];
  async function fetchTeams() {
    const result = await apiFetch("/api/teams").catch(() => null);
    if (result?.data) userTeams = result.data;
  }
  const teamsReady = fetchTeams();

  container.innerHTML = `
    <div class="dashboard-view">
      <wa-tab-group id="dashboard-tabs" active="${activeTab}">
        <wa-tab panel="links">
          <wa-icon name="link"></wa-icon>
          Links
        </wa-tab>
        <wa-tab panel="campaigns">
          <wa-icon name="bullhorn"></wa-icon>
          Campaigns
        </wa-tab>
        <wa-tab panel="teams">
          <wa-icon name="people-group"></wa-icon>
          Teams
        </wa-tab>

        <wa-tab-panel name="links">
          <div class="wa-stack wa-gap-l">
            <div class="wa-split">
              <h1>Links</h1>
              <div class="wa-cluster wa-gap-xs">
                <wa-button-group label="Create links">
                  <wa-button variant="brand" id="new-link-btn">
                    <wa-icon slot="start" name="plus"></wa-icon>
                    New Link
                  </wa-button>
                  <wa-dropdown placement="bottom-end">
                    <wa-button variant="brand" slot="trigger" id="new-link-dropdown">
                      <wa-icon name="chevron-down" label="More options"></wa-icon>
                    </wa-button>
                    <wa-dropdown-item id="bulk-create-btn">
                      <wa-icon slot="icon" name="layer-group"></wa-icon>
                      Bulk Create
                    </wa-dropdown-item>
                  </wa-dropdown>
                </wa-button-group>
              </div>
            </div>
            <div id="create-section" style="display:none;">
              <wa-card>
                <div id="create-form"></div>
              </wa-card>
            </div>
            <div id="bulk-section" style="display:none;">
              <wa-card>
                <div class="wa-stack wa-gap-m">
                  <h3>Bulk Create Links</h3>
                  <wa-select id="bulk-owner" label="Owner" size="small">
                    <wa-option value="" selected>Me</wa-option>
                  </wa-select>

                  <p class="wa-body-s wa-color-text-quiet">Enter one link per line: <code>slug, destination_url</code> (optionally: <code>slug, destination_url, title</code>)</p>
                  <wa-textarea id="bulk-input" rows="8" placeholder="my-slug, https://example.com&#10;another-slug, https://example.org, My Title"></wa-textarea>
                  <div class="wa-cluster wa-gap-s">
                    <wa-button variant="brand" id="bulk-submit-btn">
                      <wa-icon slot="start" name="paper-plane"></wa-icon>
                      Create All
                    </wa-button>
                    <wa-button variant="neutral" appearance="outlined" id="bulk-cancel-btn">Cancel</wa-button>
                  </div>
                  <div id="bulk-results" style="display:none;"></div>
                </div>
              </wa-card>
            </div>
            <div class="wa-cluster wa-gap-s">
              <wa-select id="scope-filter" size="small" style="min-width:160px;">
                <wa-option value="all" selected>All Links</wa-option>
                <wa-option value="personal">Me</wa-option>
              </wa-select>
              <wa-input id="search-input" placeholder="Search links..." with-clear style="flex:1;">
                <wa-icon slot="start" name="magnifying-glass"></wa-icon>
              </wa-input>
            </div>
            <div id="links-table"></div>
          </div>
        </wa-tab-panel>

        <wa-tab-panel name="campaigns">
          <div id="campaigns-panel"></div>
        </wa-tab-panel>

        <wa-tab-panel name="teams">
          <div id="teams-panel"></div>
        </wa-tab-panel>
      </wa-tab-group>
    </div>
  `;

  // --- Links tab ---
  let currentPage = 1;
  let searchQuery = "";
  let sortBy = "createdAt";
  let sortDir = "desc";
  let scopeFilter = "all"; // "all", "personal", or "team:<id>"

  const createSection = container.querySelector("#create-section");
  const newLinkBtn = container.querySelector("#new-link-btn");
  const searchInput = container.querySelector("#search-input");
  const scopeSelect = container.querySelector("#scope-filter");

  // Populate scope filter with teams once fetched
  function populateScopeFilter() {
    // Remove existing team options
    scopeSelect.querySelectorAll('wa-option[value^="team:"], wa-divider.scope-div, small.scope-label').forEach(el => el.remove());
    if (userTeams.length) {
      scopeSelect.insertAdjacentHTML("beforeend", `<wa-divider class="scope-div"></wa-divider><small class="scope-label">Teams</small>`);
      for (const t of userTeams) {
        const opt = document.createElement("wa-option");
        opt.value = `team:${t.id}`;
        opt.textContent = t.name;
        scopeSelect.appendChild(opt);
      }
    }
  }
  // Populate after initial teams fetch completes
  teamsReady.then(() => populateScopeFilter());

  scopeSelect.addEventListener("change", () => {
    scopeFilter = scopeSelect.value;
    currentPage = 1;
    loadLinks();
  });

  const bulkSection = container.querySelector("#bulk-section");
  const bulkBtn = container.querySelector("#bulk-create-btn");

  newLinkBtn.addEventListener("click", () => {
    bulkSection.style.display = "none";
    const visible = createSection.style.display !== "none";
    createSection.style.display = visible ? "none" : "block";
    if (!visible) {
      renderLinkForm(container.querySelector("#create-form"), {
        onSuccess: () => {
          createSection.style.display = "none";
          loadLinks();
        },
        teams: userTeams,
      });
    }
  });

  bulkBtn.addEventListener("click", () => {
    createSection.style.display = "none";
    const visible = bulkSection.style.display !== "none";
    bulkSection.style.display = visible ? "none" : "block";
    if (!visible) {
      // Populate bulk owner select with teams
      const bulkOwner = container.querySelector("#bulk-owner");
      const existingTeamOpts = bulkOwner.querySelectorAll("wa-option:not([value=''])"), divs = bulkOwner.querySelectorAll("wa-divider, small");
      existingTeamOpts.forEach(o => o.remove());
      divs.forEach(o => o.remove());
      if (userTeams.length) {
        bulkOwner.insertAdjacentHTML("beforeend", `<wa-divider></wa-divider><small>Teams</small>`);
        for (const t of userTeams) {
          const opt = document.createElement("wa-option");
          opt.value = t.id;
          opt.textContent = t.name;
          bulkOwner.appendChild(opt);
        }
      }
    }
  });

  container.querySelector("#bulk-cancel-btn").addEventListener("click", () => {
    bulkSection.style.display = "none";
  });

  container.querySelector("#bulk-submit-btn").addEventListener("click", async () => {
    const textarea = container.querySelector("#bulk-input");
    const text = textarea.value.trim();
    if (!text) { showToast("Enter at least one link", "warning"); return; }

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const links = [];
    for (const line of lines) {
      const parts = line.split(",").map(p => p.trim());
      if (parts.length < 2) {
        showToast(`Invalid line (need slug, url): "${line}"`, "warning");
        return;
      }
      links.push({ slug: parts[0], destinationUrl: parts[1], title: parts[2] || undefined });
    }

    const submitBtn = container.querySelector("#bulk-submit-btn");

    await withLoadingBtn(submitBtn, async () => {
      const bulkTeamId = container.querySelector("#bulk-owner")?.value || null;
      const result = await apiFetch("/api/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links, ...(bulkTeamId && { teamId: bulkTeamId }) }),
      });
      if (!result) return;
      const { results } = result;

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      const resultsEl = container.querySelector("#bulk-results");
      resultsEl.style.display = "block";
      resultsEl.innerHTML = `
        <wa-callout variant="${failed === 0 ? "success" : "warning"}">
          <wa-icon slot="icon" name="${failed === 0 ? "circle-check" : "triangle-exclamation"}"></wa-icon>
          ${succeeded} created${failed > 0 ? `, ${failed} failed` : ""}
        </wa-callout>
        ${failed > 0 ? `
          <table class="link-table" style="margin-top:var(--wa-space-s);" aria-label="Bulk create results">
            <thead><tr><th>Slug</th><th>Status</th><th>Error</th></tr></thead>
            <tbody>
              ${results.filter(r => !r.success).map(r => `
                <tr>
                  <td>${escapeHtml(r.slug)}</td>
                  <td><wa-badge variant="danger" pill>Failed</wa-badge></td>
                  <td>${escapeHtml(r.error)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : ""}
      `;

      if (succeeded > 0) {
        loadLinks();
        showToast(`${succeeded} link${succeeded > 1 ? "s" : ""} created`, "success");
      }
    });
  });

  bindSearchInput(searchInput, (q) => {
    searchQuery = q;
    currentPage = 1;
    loadLinks();
  });

  async function loadLinks() {
    const params = new URLSearchParams({ page: currentPage, limit: 20, sort: sortBy, dir: sortDir });
    if (searchQuery) params.set("q", searchQuery);
    if (scopeFilter === "all") {
      params.set("scope", "all");
    } else if (scopeFilter === "personal") {
      // default backend behavior, no extra param needed
    } else if (scopeFilter.startsWith("team:")) {
      params.set("teamId", scopeFilter.slice(5));
    }

    const result = await apiFetch(`/api/links?${params}`);
    if (!result) return;
    const { data, pagination } = result;

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
  }

  loadLinks();

  // --- Campaigns tab (lazy load) ---
  let campaignsLoaded = false;

  // --- Teams tab (lazy load) ---
  let teamsLoaded = false;

  async function loadTeamsPanel(selectTeamId = null) {
    await fetchTeams();
    const panel = container.querySelector("#teams-panel");

    if (selectTeamId) {
      renderTeamDetail(panel, { id: selectTeamId }, null, {
        onBack: () => loadTeamsPanel(),
        onTeamsChanged: () => fetchTeams(),
      });
      history.replaceState(null, "", "/teams/" + selectTeamId);
    } else {
      renderTeamsPanel(panel, {
        teams: userTeams,
        onTeamSelect: (id) => {
          loadTeamsPanel(id);
        },
        onTeamsChanged: () => fetchTeams(),
      });
      history.replaceState(null, "", "/teams");
    }
  }

  const tabGroup = container.querySelector("#dashboard-tabs");
  tabGroup.addEventListener("wa-tab-show", (e) => {
    if (e.detail.name === "campaigns" && !campaignsLoaded) {
      renderCampaignsPanel(container.querySelector("#campaigns-panel"))
        .then(() => { campaignsLoaded = true; })
        .catch(() => {});
    }
    if (e.detail.name === "teams" && !teamsLoaded) {
      teamsLoaded = true;
      loadTeamsPanel();
    }
    // Sync URL with active tab
    const newPath = e.detail.name === "campaigns" ? "/campaigns"
      : e.detail.name === "teams" ? "/teams"
      : "/links";
    if (location.pathname !== newPath) {
      history.replaceState(null, "", newPath);
    }
  });

  // If teams tab is active on init, load immediately
  if (activeTab === "teams") {
    teamsLoaded = true;
    loadTeamsPanel(teamId || null);
  }

}
