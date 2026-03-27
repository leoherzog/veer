import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, bindSearchInput } from "../lib/ui.js";

const IMPERSONATION_KEY = "veer_impersonating_from";

export function isImpersonating() {
  return !!sessionStorage.getItem(IMPERSONATION_KEY);
}

export function getImpersonationBanner() {
  if (!isImpersonating()) return "";
  return `
    <wa-callout variant="warning" id="impersonation-banner" style="position:fixed;top:0;left:0;right:0;z-index:1000;">
      <wa-icon slot="icon" name="mask"></wa-icon>
      <div class="wa-cluster wa-gap-s wa-align-items-center">
        <span>You are impersonating a user.</span>
        <wa-button size="small" variant="warning" id="stop-impersonate-btn">
        Stop Impersonating
      </wa-button>
      </div>
    </wa-callout>
  `;
}

export function bindImpersonationBanner() {
  const btn = document.querySelector("#stop-impersonate-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      await withLoadingBtn(btn, async () => {
        const res = await apiFetch("/api/admin/stop-impersonate", { method: "POST" });
        if (!res) return;
        sessionStorage.removeItem(IMPERSONATION_KEY);
        location.reload();
      });
    });
  }
}

export async function renderAdmin(container) {
  container.innerHTML = `
    <div class="admin-view wa-stack wa-gap-l">
      <h1>Admin Panel</h1>

      <wa-tab-group id="admin-tabs">
        <wa-tab panel="users">
          <wa-icon name="users"></wa-icon>
          Users
        </wa-tab>
        <wa-tab panel="teams">
          <wa-icon name="people-group"></wa-icon>
          Teams
        </wa-tab>

        <wa-tab-panel name="users">
          <div class="wa-stack wa-gap-m tab-panel-content">
            <wa-input id="admin-user-search" placeholder="Search users..." with-clear>
              <wa-icon slot="start" name="magnifying-glass"></wa-icon>
            </wa-input>
            <div id="admin-users-container">
              <div class="wa-stack wa-align-items-center centered-state-sm"><wa-spinner></wa-spinner></div>
            </div>
          </div>
        </wa-tab-panel>

        <wa-tab-panel name="teams">
          <div class="wa-stack wa-gap-m tab-panel-content">
            <div id="admin-teams-container">
              <div class="wa-stack wa-align-items-center centered-state-sm"><wa-spinner></wa-spinner></div>
            </div>
          </div>
        </wa-tab-panel>
      </wa-tab-group>

      <wa-dialog id="edit-user-dialog" label="Edit User">
        <div class="wa-stack wa-gap-m">
          <p>Editing <strong id="edit-user-name"></strong></p>
          <wa-input id="edit-user-maxlinks" label="Max Links" type="number" min="0"></wa-input>
        </div>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" id="confirm-edit-user">Save</wa-button>
      </wa-dialog>
    </div>
  `;

  // --- Users tab ---
  let usersPage = 1;
  let usersSearch = "";

  async function loadUsers() {
    const usersContainer = container.querySelector("#admin-users-container");
    usersContainer.innerHTML = `<div class="wa-stack wa-align-items-center centered-state-sm"><wa-spinner></wa-spinner></div>`;

    const params = new URLSearchParams({ page: usersPage, limit: 20 });
    if (usersSearch) params.set("q", usersSearch);

    try {
      const result = await apiFetch(`/api/admin/users?${params}`);
      if (!result) { usersContainer.innerHTML = `<wa-callout variant="danger">Failed to load users.</wa-callout>`; return; }
      const { data: users, pagination } = result;

      if (!users.length) {
        usersContainer.innerHTML = `<p class="wa-color-text-quiet centered-state-sm">No users found.</p>`;
        return;
      }

      usersContainer.innerHTML = `
        <table class="link-table" aria-label="All users">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Links</th>
              <th>Max Links</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td>
                  <div class="wa-cluster wa-gap-xs">
                    <wa-avatar image="${escapeAttr(u.image || "")}" label="${escapeAttr(u.name || u.email)}" style="--size:1.5rem;"></wa-avatar>
                    ${escapeHtml(u.name || "—")}
                  </div>
                </td>
                <td>${escapeHtml(u.email)}</td>
                <td>${Number(u.linkCount) || 0}</td>
                <td>${u.maxLinks != null ? Number(u.maxLinks) : "Unlimited"}</td>
                <td>
                  <div class="wa-cluster wa-gap-2xs">
                    <wa-button size="small" variant="neutral" appearance="outlined" class="admin-edit-user-btn" data-user-id="${escapeAttr(u.id)}" data-name="${escapeAttr(u.name || u.email)}" data-max-links="${escapeAttr(String(u.maxLinks ?? ""))}">
                      <wa-icon slot="start" name="pen-to-square"></wa-icon>
                      Edit
                    </wa-button>
                    <wa-button size="small" variant="warning" appearance="outlined" class="admin-impersonate-btn" data-user-id="${escapeAttr(u.id)}">
                      <wa-icon slot="start" name="mask"></wa-icon>
                      Impersonate
                    </wa-button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        ${pagination && pagination.total > pagination.limit ? `
          <div class="wa-cluster wa-gap-s wa-justify-content-center pagination-row">
            <wa-button size="small" variant="neutral" ${usersPage <= 1 ? "disabled" : ""} id="users-prev-page">Previous</wa-button>
            <span>Page ${Number(pagination.page)} of ${Math.ceil(Number(pagination.total) / Number(pagination.limit))}</span>
            <wa-button size="small" variant="neutral" ${usersPage * pagination.limit >= pagination.total ? "disabled" : ""} id="users-next-page">Next</wa-button>
          </div>
        ` : ""}
      `;

      // Pagination
      usersContainer.querySelector("#users-prev-page")?.addEventListener("click", () => { usersPage--; loadUsers(); });
      usersContainer.querySelector("#users-next-page")?.addEventListener("click", () => { usersPage++; loadUsers(); });

      // Edit user
      usersContainer.querySelectorAll(".admin-edit-user-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const dialog = container.querySelector("#edit-user-dialog");
          container.querySelector("#edit-user-name").textContent = btn.dataset.name;
          const maxLinksInput = container.querySelector("#edit-user-maxlinks");
          maxLinksInput.value = btn.dataset.maxLinks;
          dialog.dataset.userId = btn.dataset.userId;
          dialog.open = true;
        });
      });

      // Impersonate
      usersContainer.querySelectorAll(".admin-impersonate-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await withLoadingBtn(btn, async () => {
            const result = await apiFetch(`/api/admin/impersonate/${encodeURIComponent(btn.dataset.userId)}`, { method: "POST" });
            if (!result) return;
            sessionStorage.setItem(IMPERSONATION_KEY, result.adminUserId);
            location.href = "/links";
          });
        });
      });
    } catch {
      usersContainer.innerHTML = `<wa-callout variant="danger">Failed to load users.</wa-callout>`;
    }
  }

  // User search
  const searchInput = container.querySelector("#admin-user-search");
  bindSearchInput(searchInput, (q) => {
    usersSearch = q;
    usersPage = 1;
    loadUsers();
  });

  // Edit user dialog
  const editDialog = container.querySelector("#edit-user-dialog");
  container.querySelector("#confirm-edit-user").addEventListener("click", async () => {
    const userId = editDialog.dataset.userId;
    const maxLinksInput = container.querySelector("#edit-user-maxlinks");
    const maxLinks = maxLinksInput.value === "" ? null : parseInt(maxLinksInput.value, 10);

    const confirmBtn = container.querySelector("#confirm-edit-user");
    await withLoadingBtn(confirmBtn, async () => {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxLinks }),
      });
      if (!res) return;
      editDialog.open = false;
      showToast("User updated", "success");
      loadUsers();
    });
  });

  // Load users immediately
  loadUsers();

  // --- Teams tab (lazy) ---
  let teamsLoaded = false;
  let teamsPage = 1;

  async function loadAdminTeams() {
    const teamsContainer = container.querySelector("#admin-teams-container");
    teamsContainer.innerHTML = `<div class="wa-stack wa-align-items-center centered-state-sm"><wa-spinner></wa-spinner></div>`;

    const params = new URLSearchParams({ page: teamsPage, limit: 20 });
    try {
      const result = await apiFetch(`/api/admin/teams?${params}`);
      if (!result) { teamsContainer.innerHTML = `<wa-callout variant="danger">Failed to load teams.</wa-callout>`; return; }
      const { data: teams, pagination } = result;

      if (!teams.length) {
        teamsContainer.innerHTML = `<p class="wa-color-text-quiet centered-state-sm">No teams found.</p>`;
        return;
      }

      teamsContainer.innerHTML = `
        <table class="link-table" aria-label="All teams">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Members</th>
              <th>Links</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${teams.map(t => `
              <tr>
                <td>${escapeHtml(t.name)}</td>
                <td>/${escapeHtml(t.slug)}</td>
                <td>${Number(t.memberCount) || 0}</td>
                <td>${Number(t.linkCount) || 0}</td>
                <td>
                  <wa-button size="small" variant="danger" appearance="outlined" class="admin-delete-team-btn" data-team-id="${escapeAttr(t.id)}" data-name="${escapeAttr(t.name)}">
                    <wa-icon slot="start" name="trash"></wa-icon>
                    Delete
                  </wa-button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        ${pagination && pagination.total > pagination.limit ? `
          <div class="wa-cluster wa-gap-s wa-justify-content-center pagination-row">
            <wa-button size="small" variant="neutral" ${teamsPage <= 1 ? "disabled" : ""} id="teams-prev-page">Previous</wa-button>
            <span>Page ${Number(pagination.page)} of ${Math.ceil(Number(pagination.total) / Number(pagination.limit))}</span>
            <wa-button size="small" variant="neutral" ${teamsPage * pagination.limit >= pagination.total ? "disabled" : ""} id="teams-next-page">Next</wa-button>
          </div>
        ` : ""}
      `;

      // Pagination
      teamsContainer.querySelector("#teams-prev-page")?.addEventListener("click", () => { teamsPage--; loadAdminTeams(); });
      teamsContainer.querySelector("#teams-next-page")?.addEventListener("click", () => { teamsPage++; loadAdminTeams(); });

      // Delete team
      teamsContainer.querySelectorAll(".admin-delete-team-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Delete team "${btn.dataset.name}"? This cannot be undone.`)) return;
          await withLoadingBtn(btn, async () => {
            const res = await apiFetch(`/api/admin/teams/${encodeURIComponent(btn.dataset.teamId)}`, { method: "DELETE" });
            if (!res) return;
            showToast("Team deleted", "success");
            loadAdminTeams();
          });
        });
      });
    } catch {
      teamsContainer.innerHTML = `<wa-callout variant="danger">Failed to load teams.</wa-callout>`;
    }
  }

  const tabGroup = container.querySelector("#admin-tabs");
  tabGroup.addEventListener("wa-tab-show", (e) => {
    if (e.detail.name === "teams" && !teamsLoaded) {
      teamsLoaded = true;
      loadAdminTeams();
    }
  });
}
