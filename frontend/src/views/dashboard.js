import { renderLinkForm } from "../components/link-form.js";
import { renderLinkTable } from "../components/link-table.js";
import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { renderCampaignsPanel } from "./campaigns.js";
import { escapeHtml } from "../lib/escape.js";

export function renderDashboard(container, { activeTab = "links" } = {}) {
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

        <wa-tab-panel name="links">
          <div class="wa-stack wa-gap-l">
            <div class="wa-split">
              <h1>Your Links</h1>
              <div class="wa-cluster wa-gap-xs">
                <wa-button variant="brand" id="new-link-btn">
                  <wa-icon slot="start" name="plus"></wa-icon>
                  New Link
                </wa-button>
                <wa-button variant="neutral" appearance="outlined" id="bulk-create-btn">
                  <wa-icon slot="start" name="layer-group"></wa-icon>
                  Bulk Create
                </wa-button>
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
      });
    }
  });

  bulkBtn.addEventListener("click", () => {
    createSection.style.display = "none";
    const visible = bulkSection.style.display !== "none";
    bulkSection.style.display = visible ? "none" : "block";
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
    submitBtn.loading = true;
    submitBtn.disabled = true;

    try {
      const res = await fetch("/api/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
      });
      const { results } = await res.json();
      if (!res.ok && !results) {
        showToast("Bulk create failed", "danger");
        return;
      }

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
    } catch {
      showToast("Network error", "danger");
    } finally {
      submitBtn.loading = false;
      submitBtn.disabled = false;
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

}
