import { bindLinkFormDialog } from "../components/link-form.js";
import { renderLinkTable } from "../components/link-table.js";
import { showToast } from "../components/toast.js";
import { renderCampaignsPanel } from "./campaigns.js";
import { renderTeamsPanel } from "./teams.js";
import { renderTeamDetail } from "./team-detail.js";
import { escapeHtml } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, bindSearchInput, renderTable, setTeamOptions } from "../lib/ui.js";

/** Matches the server-side cap on POST /api/bulk. */
const BULK_MAX = 50;

export function renderDashboard(container, { activeTab = "links", teamId = null, user } = {}) {
  let userTeams = [];
  async function fetchTeams() {
    const result = await apiFetch("/api/teams");
    if (result?.data) userTeams = result.data;
  }
  const teamsReady = fetchTeams();

  container.innerHTML = `
      <wa-tab-group without-scroll-controls id="dashboard-tabs" active="${activeTab}">
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
                  <wa-button variant="brand" id="new-link-btn" data-dialog="open new-link-dialog">
                    <wa-icon slot="start" name="plus"></wa-icon>
                    New Link
                  </wa-button>
                  <wa-dropdown placement="bottom-end">
                    <wa-button variant="brand" slot="trigger">
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
            <div class="wa-cluster wa-gap-s">
              <wa-select id="scope-filter" label="Link scope" class="wa-visually-hidden-label" size="s" style="min-width:160px;">
                <wa-option value="all" selected>All Links</wa-option>
                <wa-option value="personal">Me</wa-option>
              </wa-select>
              <wa-input id="search-input" label="Search links" class="wa-visually-hidden-label" placeholder="Search links..." with-clear style="flex:1;">
                <wa-icon slot="start" name="magnifying-glass"></wa-icon>
              </wa-input>
            </div>
            <div id="links-table"></div>

            <wa-dialog id="new-link-dialog" label="New Link" style="--width:640px;"></wa-dialog>

            <wa-dialog id="bulk-create-dialog" label="Bulk Create Links" light-dismiss style="--width:640px;">
              <div class="wa-stack wa-gap-m">
                <wa-select id="bulk-owner" label="Owner" size="s">
                  <wa-option value="" selected>Me</wa-option>
                </wa-select>

                <p class="wa-body-s wa-color-text-quiet">Enter one link per line: <code>slug, destination_url</code> (optionally: <code>slug, destination_url, title</code>)</p>
                <wa-textarea id="bulk-input" label="Links to create" class="wa-visually-hidden-label" rows="8" placeholder="my-slug, https://example.com&#10;another-slug, https://example.org, My Title"></wa-textarea>
                <div id="bulk-results" hidden></div>
              </div>
              <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
              <wa-button slot="footer" variant="brand" id="bulk-submit-btn">
                <wa-icon slot="start" name="paper-plane"></wa-icon>
                Create All
              </wa-button>
            </wa-dialog>
          </div>
        </wa-tab-panel>

        <wa-tab-panel name="campaigns">
          <div id="campaigns-panel"></div>
        </wa-tab-panel>

        <wa-tab-panel name="teams">
          <div id="teams-panel"></div>
        </wa-tab-panel>
      </wa-tab-group>
  `;

  // --- Links tab ---
  let currentPage = 1;
  let searchQuery = "";
  let sortBy = "createdAt";
  let sortDir = "desc";
  let scopeFilter = "all"; // "all", "personal", or "team:<id>"

  const searchInput = container.querySelector("#search-input");
  const scopeSelect = container.querySelector("#scope-filter");

  // Populate scope filter with teams once the initial fetch completes
  function refreshScopeOptions() {
    setTeamOptions(scopeSelect, userTeams, { prefix: "team:", selected: scopeFilter });
    scopeSelect.value = scopeFilter;
  }
  teamsReady.then(refreshScopeOptions);

  scopeSelect.addEventListener("change", () => {
    scopeFilter = scopeSelect.value;
    currentPage = 1;
    loadLinks();
  });

  const bulkDialog = container.querySelector("#bulk-create-dialog");
  const createDropdown = container.querySelector("wa-button-group wa-dropdown");

  bindLinkFormDialog(container.querySelector("#new-link-dialog"), () => ({ teams: userTeams }), loadLinks);

  bulkDialog.addEventListener("wa-show", (e) => {
    if (e.target !== bulkDialog) return;
    setTeamOptions(container.querySelector("#bulk-owner"), userTeams);
    // Reopening starts a fresh batch, not a re-run of the last one.
    container.querySelector("#bulk-input").value = "";
    const previousResults = container.querySelector("#bulk-results");
    previousResults.hidden = true;
    previousResults.innerHTML = "";
  });

  createDropdown.addEventListener("wa-select", (e) => {
    if (e.detail.item.id !== "bulk-create-btn") return;
    bulkDialog.open = true;
  });

  container.querySelector("#bulk-submit-btn").addEventListener("click", async () => {
    const textarea = container.querySelector("#bulk-input");
    const text = textarea.value.trim();
    if (!text) { showToast("Enter at least one link", "warning"); return; }

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length > BULK_MAX) {
      showToast(`Bulk create takes at most ${BULK_MAX} links at a time — you pasted ${lines.length}.`, "warning");
      return;
    }

    const links = [];
    for (const line of lines) {
      // Only the first two commas delimit fields, so the title may contain commas.
      const [rawSlug, rawUrl = "", ...title] = line.split(",");
      const slug = rawSlug.trim();
      const destinationUrl = rawUrl.trim();
      if (!slug || !destinationUrl) {
        showToast(`Invalid line (need slug, url): "${line}"`, "warning");
        return;
      }
      links.push({ slug, destinationUrl, title: title.join(",").trim() || undefined });
    }

    const submitBtn = container.querySelector("#bulk-submit-btn");

    await withLoadingBtn(submitBtn, async () => {
      const bulkTeamId = container.querySelector("#bulk-owner").value || null;
      const result = await apiFetch("/api/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links, ...(bulkTeamId && { teamId: bulkTeamId }) }),
      });
      if (!result) return;
      const { results } = result;

      const failures = results.filter(r => !r.success);
      const succeeded = results.length - failures.length;

      const resultsEl = container.querySelector("#bulk-results");
      resultsEl.hidden = false;
      resultsEl.innerHTML = `
        <div class="wa-stack wa-gap-s">
          <wa-callout variant="${failures.length === 0 ? "success" : "warning"}">
            <wa-icon slot="icon" name="${failures.length === 0 ? "circle-check" : "triangle-exclamation"}"></wa-icon>
            ${succeeded} created${failures.length > 0 ? `, ${failures.length} failed` : ""}
          </wa-callout>
          ${failures.length > 0 ? renderTable({
            label: "Bulk create results",
            columns: ["Slug", "Status", "Error"],
            rows: failures.map(r => `
              <tr>
                <td>${escapeHtml(r.slug)}</td>
                <td><wa-badge variant="danger" pill>Failed</wa-badge></td>
                <td>${escapeHtml(r.error)}</td>
              </tr>
            `),
          }) : ""}
        </div>
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
    refreshScopeOptions();
    const panel = container.querySelector("#teams-panel");

    if (selectTeamId) {
      renderTeamDetail(panel, { id: selectTeamId }, user, {
        onBack: () => loadTeamsPanel(),
        onTeamsChanged: async () => { await fetchTeams(); refreshScopeOptions(); },
      });
      history.replaceState(null, "", "/teams/" + selectTeamId);
    } else {
      renderTeamsPanel(panel, {
        teams: userTeams,
        onTeamSelect: (id) => {
          loadTeamsPanel(id);
        },
      });
      history.replaceState(null, "", "/teams");
    }
  }

  const tabGroup = container.querySelector("#dashboard-tabs");
  tabGroup.addEventListener("wa-tab-show", (e) => {
    if (e.target !== tabGroup) return;
    if (e.detail.name === "campaigns" && !campaignsLoaded) {
      renderCampaignsPanel(container.querySelector("#campaigns-panel"))
        .then(() => { campaignsLoaded = true; });
    }
    if (e.detail.name === "teams" && !teamsLoaded) {
      teamsLoaded = true;
      loadTeamsPanel();
    }
    const newPath = e.detail.name === "campaigns" ? "/campaigns"
      : e.detail.name === "teams" ? "/teams"
      : "/links";
    if (location.pathname !== newPath) {
      history.replaceState(null, "", newPath);
    }
  });

  if (activeTab === "teams") {
    teamsLoaded = true;
    loadTeamsPanel(teamId || null);
  }

}
