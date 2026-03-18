import { renderLinkForm } from "../components/link-form.js";
import { renderLinkTable } from "../components/link-table.js";
import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";

export function renderDashboard(container) {
  container.innerHTML = `
    <div class="dashboard-view wa-stack wa-gap-l" style="max-width:960px;margin:2rem auto;">
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
  `;

  let currentPage = 1;
  let searchQuery = "";

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
    const params = new URLSearchParams({ page: currentPage, limit: 20 });
    if (searchQuery) params.set("q", searchQuery);

    try {
      const res = await fetch(`/api/links?${params}`);
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) { showToast("Failed to load links", "danger"); return; }
      const { data, pagination } = await res.json();

      renderLinkTable(container.querySelector("#links-table"), {
        links: data,
        pagination,
        onPageChange: (page) => {
          currentPage = page;
          loadLinks();
        },
      });
    } catch {
      showToast("Failed to load links", "danger");
    }
  }

  loadLinks();
}
