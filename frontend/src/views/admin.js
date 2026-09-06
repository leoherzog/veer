import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, bindSearchInput, bindConfirmDialog, loadTableSection } from "../lib/ui.js";

const IMPERSONATION_KEY = "veer_impersonating_from";

export function isImpersonating() {
  return !!sessionStorage.getItem(IMPERSONATION_KEY);
}

export function getImpersonationBanner() {
  if (!isImpersonating()) return "";
  return `
    <wa-callout variant="warning" id="impersonation-banner" slot="banner">
      <wa-icon slot="icon" name="mask"></wa-icon>
      <div class="wa-cluster wa-gap-s wa-align-items-center">
        <span>You are impersonating a user.</span>
        <wa-button size="s" variant="warning" id="stop-impersonate-btn">
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
    <div class="wa-stack wa-gap-l">
      <h1>Admin Panel</h1>

      <wa-tab-group without-scroll-controls id="admin-tabs">
        <wa-tab panel="users">
          <wa-icon name="users"></wa-icon>
          Users
        </wa-tab>
        <wa-tab panel="teams">
          <wa-icon name="people-group"></wa-icon>
          Teams
        </wa-tab>

        <wa-tab-panel name="users">
          <div class="wa-stack wa-gap-m">
            <wa-input id="admin-user-search" label="Search users" class="wa-visually-hidden-label" placeholder="Search users..." with-clear>
              <wa-icon slot="start" name="magnifying-glass"></wa-icon>
            </wa-input>
            <div id="admin-users-container">
              <div class="wa-stack wa-align-items-center"><wa-spinner></wa-spinner></div>
            </div>
          </div>
        </wa-tab-panel>

        <wa-tab-panel name="teams">
          <div class="wa-stack wa-gap-m">
            <div id="admin-teams-container">
              <div class="wa-stack wa-align-items-center"><wa-spinner></wa-spinner></div>
            </div>
          </div>
        </wa-tab-panel>
      </wa-tab-group>

      <wa-dialog id="edit-user-dialog" label="Edit User" light-dismiss>
        <div class="wa-stack wa-gap-m">
          <p>Editing <strong id="edit-user-name"></strong></p>
          <wa-input id="edit-user-maxlinks" label="Max Links" type="number" min="1" hint="Leave empty for unlimited"></wa-input>
        </div>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" id="confirm-edit-user">Save</wa-button>
      </wa-dialog>

      <wa-dialog id="delete-team-dialog" label="Delete Team" light-dismiss>
        <p>Are you sure you want to delete <strong id="delete-team-name"></strong>? This cannot be undone.</p>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="danger" id="confirm-delete-team">Delete</wa-button>
      </wa-dialog>
    </div>
  `;

  // --- Users tab ---
  let usersPage = 1;
  let usersSearch = "";

  async function loadUsers() {
    const params = new URLSearchParams({ page: usersPage, limit: 20 });
    if (usersSearch) params.set("q", usersSearch);

    const usersContainer = await loadTableSection(container.querySelector("#admin-users-container"), {
      url: `/api/admin/users?${params}`,
      label: "All users",
      headers: ["Name", "Email", "Links", "Max Links", "Actions"],
      renderRow: (u) => `
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
              <wa-button size="s" variant="neutral" appearance="outlined" class="admin-edit-user-btn" data-user-id="${escapeAttr(u.id)}" data-name="${escapeAttr(u.name || u.email)}" data-max-links="${escapeAttr(String(u.maxLinks ?? ""))}">
                <wa-icon slot="start" name="pen-to-square"></wa-icon>
                Edit
              </wa-button>
              <wa-button size="s" variant="warning" appearance="outlined" class="admin-impersonate-btn" data-user-id="${escapeAttr(u.id)}">
                <wa-icon slot="start" name="mask"></wa-icon>
                Impersonate
              </wa-button>
            </div>
          </td>
        </tr>
      `,
      empty: "No users found.",
      error: "Failed to load users.",
      onPageChange: (p) => { usersPage = p; loadUsers(); },
    });
    if (!usersContainer) return;

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
  bindConfirmDialog({
    dialog: editDialog,
    confirmBtn: container.querySelector("#confirm-edit-user"),
    onConfirm: async () => {
      const maxLinksInput = container.querySelector("#edit-user-maxlinks");
      const rawMaxLinks = maxLinksInput.value.trim();
      // An empty field means unlimited; the API rejects 0.
      const maxLinks = rawMaxLinks === "" ? null : parseInt(rawMaxLinks, 10);
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(editDialog.dataset.userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxLinks }),
      });
      if (!res) return false;
      showToast("User updated", "success");
      loadUsers();
    },
  });

  // Load users immediately
  loadUsers();

  // --- Teams tab (lazy) ---
  let teamsLoaded = false;
  let teamsPage = 1;

  async function loadAdminTeams() {
    const params = new URLSearchParams({ page: teamsPage, limit: 20 });

    const teamsContainer = await loadTableSection(container.querySelector("#admin-teams-container"), {
      url: `/api/admin/teams?${params}`,
      label: "All teams",
      headers: ["Name", "Slug", "Members", "Links", "Actions"],
      renderRow: (t) => `
        <tr>
          <td>${escapeHtml(t.name)}</td>
          <td>/${escapeHtml(t.slug)}</td>
          <td>${Number(t.memberCount) || 0}</td>
          <td>${Number(t.linkCount) || 0}</td>
          <td>
            <wa-button size="s" variant="danger" appearance="outlined" class="admin-delete-team-btn" data-team-id="${escapeAttr(t.id)}" data-name="${escapeAttr(t.name)}">
              <wa-icon slot="start" name="trash"></wa-icon>
              Delete
            </wa-button>
          </td>
        </tr>
      `,
      empty: "No teams found.",
      error: "Failed to load teams.",
      onPageChange: (p) => { teamsPage = p; loadAdminTeams(); },
    });
    if (!teamsContainer) return;

    // Delete team
    teamsContainer.querySelectorAll(".admin-delete-team-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        container.querySelector("#delete-team-name").textContent = btn.dataset.name;
        deleteTeamDialog.dataset.teamId = btn.dataset.teamId;
        deleteTeamDialog.open = true;
      });
    });
  }

  // Delete team dialog — bound once; loadAdminTeams re-runs on every page change
  const deleteTeamDialog = container.querySelector("#delete-team-dialog");
  bindConfirmDialog({
    dialog: deleteTeamDialog,
    confirmBtn: container.querySelector("#confirm-delete-team"),
    onConfirm: async () => {
      const res = await apiFetch(`/api/admin/teams/${encodeURIComponent(deleteTeamDialog.dataset.teamId)}`, { method: "DELETE" });
      if (!res) return false;
      showToast("Team deleted", "success");
      loadAdminTeams();
    },
  });

  const tabGroup = container.querySelector("#admin-tabs");
  tabGroup.addEventListener("wa-tab-show", (e) => {
    if (e.detail.name === "teams" && !teamsLoaded) {
      teamsLoaded = true;
      loadAdminTeams();
    }
  });
}
