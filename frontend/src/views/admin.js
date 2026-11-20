import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, bindSearchInput, bindConfirmDialog, loadTableSection, delegateClick } from "../lib/ui.js";

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

/** The max-links control, rebuilt on each open so no earlier entry or validity state carries over. */
function maxLinksField(value) {
  return `<wa-number-input id="edit-user-maxlinks" label="Max Links" min="1" without-steppers hint="Leave empty for unlimited" value="${escapeAttr(value)}"></wa-number-input>`;
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
            <div id="admin-users-container"></div>
          </div>
        </wa-tab-panel>

        <wa-tab-panel name="teams">
          <div id="admin-teams-container"></div>
        </wa-tab-panel>
      </wa-tab-group>

      <wa-dialog id="edit-user-dialog" label="Edit User" light-dismiss>
        <div class="wa-stack wa-gap-m">
          <p>Editing <strong id="edit-user-name"></strong></p>
          ${maxLinksField("")}
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
              <wa-avatar class="row-avatar" image="${escapeAttr(u.image)}" label="${escapeAttr(u.name || u.email)}"></wa-avatar>
              ${escapeHtml(u.name || "—")}
            </div>
          </td>
          <td>${escapeHtml(u.email)}</td>
          <td>${u.linkCount}</td>
          <td>${u.maxLinks != null ? Number(u.maxLinks) : "Unlimited"}</td>
          <td>
            <div class="wa-cluster wa-gap-2xs">
              <wa-button size="s" variant="neutral" appearance="outlined" class="admin-edit-user-btn" data-dialog="open edit-user-dialog" data-user-id="${escapeAttr(u.id)}" data-name="${escapeAttr(u.name || u.email)}" data-max-links="${escapeAttr(String(u.maxLinks ?? ""))}">
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

  const searchInput = container.querySelector("#admin-user-search");
  bindSearchInput(searchInput, (q) => {
    usersSearch = q;
    usersPage = 1;
    loadUsers();
  });

  const editDialog = container.querySelector("#edit-user-dialog");
  delegateClick(container.querySelector("#admin-users-container"), ".admin-edit-user-btn", (btn) => {
    container.querySelector("#edit-user-name").textContent = btn.dataset.name;
    editDialog.querySelector("#edit-user-maxlinks").outerHTML = maxLinksField(btn.dataset.maxLinks);
    editDialog.dataset.userId = btn.dataset.userId;
  });

  bindConfirmDialog({
    dialog: editDialog,
    confirmBtn: container.querySelector("#confirm-edit-user"),
    onConfirm: async () => {
      const maxLinksInput = editDialog.querySelector("#edit-user-maxlinks");
      // A garbled entry reads as empty, which would save unlimited; reportValidity
      // also rejects fractions and values below 1.
      if (!maxLinksInput.reportValidity()) return false;
      const raw = maxLinksInput.value ?? "";
      const maxLinks = raw === "" ? null : Number(raw);
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(editDialog.dataset.userId)}`, {
        method: "PATCH",
        json: { maxLinks },
      });
      if (!res) return false;
      showToast("User updated", "success");
      loadUsers();
    },
  });

  loadUsers();

  // --- Teams tab (lazy) ---
  let teamsLoaded = false;
  let teamsPage = 1;

  function loadAdminTeams() {
    const params = new URLSearchParams({ page: teamsPage, limit: 20 });

    loadTableSection(container.querySelector("#admin-teams-container"), {
      url: `/api/admin/teams?${params}`,
      label: "All teams",
      headers: ["Name", "Members", "Links", "Actions"],
      renderRow: (t) => `
        <tr>
          <td>${escapeHtml(t.name)}</td>
          <td>${t.memberCount}</td>
          <td>${t.linkCount}</td>
          <td>
            <wa-button size="s" variant="danger" appearance="outlined" class="admin-delete-team-btn" data-dialog="open delete-team-dialog" data-team-id="${escapeAttr(t.id)}" data-name="${escapeAttr(t.name)}">
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
  }

  const deleteTeamDialog = container.querySelector("#delete-team-dialog");
  delegateClick(container.querySelector("#admin-teams-container"), ".admin-delete-team-btn", (btn) => {
    container.querySelector("#delete-team-name").textContent = btn.dataset.name;
    deleteTeamDialog.dataset.teamId = btn.dataset.teamId;
  });

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
