import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { SPINNER, apiFetch, withLoadingBtn } from "../lib/ui.js";

function renderMemberRow(member, isAdmin) {
  return `
    <tr>
      <td>
        <div class="wa-cluster wa-gap-xs">
          <wa-avatar image="${escapeAttr(member.image || "")}" label="${escapeAttr(member.name || member.email || member.userId)}" style="--size:1.5rem;"></wa-avatar>
          ${escapeHtml(member.name || member.email || member.userId)}
        </div>
      </td>
      <td>${escapeHtml(member.email || "")}</td>
      <td><wa-badge variant="${member.role === "admin" ? "brand" : "neutral"}" pill>${escapeHtml(member.role)}</wa-badge></td>
      <td>
        ${isAdmin ? `
          <div class="wa-cluster wa-gap-2xs">
            <wa-button size="small" variant="neutral" appearance="outlined" class="change-role-btn" data-user-id="${escapeAttr(member.userId)}" data-current-role="${escapeAttr(member.role)}">
              <wa-icon slot="start" name="arrows-rotate"></wa-icon>
              ${member.role === "admin" ? "Demote" : "Promote"}
            </wa-button>
            <wa-button size="small" variant="danger" appearance="outlined" class="remove-member-btn" data-user-id="${escapeAttr(member.userId)}" data-name="${escapeAttr(member.name || member.email || member.userId)}">
              <wa-icon slot="start" name="user-minus"></wa-icon>
              Remove
            </wa-button>
          </div>
        ` : ""}
      </td>
    </tr>
  `;
}

function renderInviteRow(invite) {
  return `
    <tr>
      <td>${escapeHtml(invite.email)}</td>
      <td><wa-badge variant="${invite.role === "admin" ? "brand" : "neutral"}" pill>${escapeHtml(invite.role)}</wa-badge></td>
      <td><wa-relative-time date="${escapeAttr(invite.expiresAt)}"></wa-relative-time></td>
      <td>
        <wa-button size="small" variant="danger" appearance="outlined" class="cancel-invite-btn" data-invite-id="${escapeAttr(invite.id)}">
          <wa-icon slot="start" name="xmark"></wa-icon>
          Cancel
        </wa-button>
      </td>
    </tr>
  `;
}

export async function renderTeamDetail(container, { id }, currentUser = null, { onBack, onTeamsChanged } = {}) {
  container.innerHTML = SPINNER;

  let currentUserId = currentUser?.id;
  if (!currentUserId) {
    const meResult = await apiFetch("/api/me").catch(() => null);
    if (meResult?.data) currentUserId = meResult.data.id;
  }

  const teamResult = await apiFetch(`/api/teams/${encodeURIComponent(id)}`);
  if (!teamResult) return;
  const { data: team } = teamResult;

  // Determine current user's role from members list
  const members = team.members || [];
  const currentMember = members.find(m => m.userId === currentUserId);
  const isAdmin = currentMember?.role === "admin";

  // Fetch invites if admin
  let invites = [];
  if (isAdmin) {
    const invResult = await apiFetch(`/api/teams/${encodeURIComponent(id)}/invites`).catch(() => null);
    if (invResult?.data) invites = invResult.data;
  }

  function goBack() {
    if (onBack) {
      onBack();
    } else {
      navigate("/teams");
    }
  }

  container.innerHTML = `
    <div class="team-detail-view wa-stack wa-gap-l">
      <div class="wa-split">
        <div class="wa-stack wa-gap-2xs">
          <div class="wa-cluster wa-gap-s">
            <wa-button variant="neutral" appearance="plain" size="small" id="back-to-teams">
              <wa-icon name="arrow-left"></wa-icon>
            </wa-button>
            <h1>${escapeHtml(team.name)}</h1>
          </div>
          <span class="wa-body-s wa-color-text-quiet">/${escapeHtml(team.slug)}</span>
        </div>
        ${isAdmin ? `
          <div class="wa-cluster wa-gap-xs">
            <wa-button variant="neutral" appearance="outlined" id="edit-team-btn">
              <wa-icon slot="start" name="pen-to-square"></wa-icon>
              Edit
            </wa-button>
            <wa-button variant="danger" appearance="outlined" id="delete-team-btn">
              <wa-icon slot="start" name="trash"></wa-icon>
              Delete
            </wa-button>
          </div>
        ` : `
          <wa-button variant="danger" appearance="outlined" id="leave-team-btn">
            <wa-icon slot="start" name="right-from-bracket"></wa-icon>
            Leave Team
          </wa-button>
        `}
      </div>

      <wa-tab-group id="team-tabs">
        <wa-tab panel="members">
          <wa-icon name="users"></wa-icon>
          Members
        </wa-tab>
        ${isAdmin ? `
          <wa-tab panel="invites">
            <wa-icon name="envelope"></wa-icon>
            Invites
          </wa-tab>
        ` : ""}

        <wa-tab-panel name="members">
          <div class="wa-stack wa-gap-m tab-panel-content">
            ${isAdmin ? `
              <wa-card>
                <div class="wa-stack wa-gap-m">
                  <h3>Invite Member</h3>
                  <form id="invite-form" class="wa-cluster wa-gap-s wa-align-items-end">
                    <wa-input id="invite-email" label="Email" type="email" placeholder="user@example.com" required></wa-input>
                    <wa-select id="invite-role" label="Role">
                      <wa-option value="member" selected>Member</wa-option>
                      <wa-option value="admin">Admin</wa-option>
                    </wa-select>
                    <wa-button type="submit" variant="brand" size="small">
                      <wa-icon slot="start" name="paper-plane"></wa-icon>
                      Invite
                    </wa-button>
                  </form>
                </div>
              </wa-card>
            ` : ""}
            <wa-card>
              <div class="wa-stack wa-gap-m">
                <h3>Members</h3>
                ${members.length === 0
                  ? `<p class="wa-color-text-quiet">No members.</p>`
                  : `
                    <table class="link-table" aria-label="Team members">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Email</th>
                          <th>Role</th>
                          <th>${isAdmin ? "Actions" : ""}</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${members.map(m => renderMemberRow(m, isAdmin)).join("")}
                      </tbody>
                    </table>
                  `
                }
              </div>
            </wa-card>
          </div>
        </wa-tab-panel>

        ${isAdmin ? `
          <wa-tab-panel name="invites">
            <div class="wa-stack wa-gap-m tab-panel-content">
              <wa-card>
                <div class="wa-stack wa-gap-m">
                  <h3>Pending Invites</h3>
                  ${invites.length === 0
                    ? `<p class="wa-color-text-quiet">No pending invites.</p>`
                    : `
                      <table class="link-table" aria-label="Pending invites">
                        <thead>
                          <tr>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Expires</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody id="invites-tbody">
                          ${invites.map(i => renderInviteRow(i)).join("")}
                        </tbody>
                      </table>
                    `
                  }
                </div>
              </wa-card>
            </div>
          </wa-tab-panel>
        ` : ""}
      </wa-tab-group>

      <wa-dialog id="edit-team-dialog" label="Edit Team" light-dismiss>
        <wa-input id="edit-team-name" label="Team Name" value="${escapeAttr(team.name)}" required></wa-input>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" id="confirm-edit-team">Save</wa-button>
      </wa-dialog>

      <wa-dialog id="delete-team-dialog" label="Delete Team" light-dismiss>
        <p>Are you sure you want to delete <strong>${escapeHtml(team.name)}</strong>? This cannot be undone. All team links will be unlinked from the team.</p>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="danger" id="confirm-delete-team">Delete</wa-button>
      </wa-dialog>
    </div>
  `;

  // Back button
  container.querySelector("#back-to-teams").addEventListener("click", () => goBack());

  // Re-render preserving the active tab
  async function reloadPreservingTab() {
    const activePanel = container.querySelector("#team-tabs")?.active || "members";
    await renderTeamDetail(container, { id }, currentUser, { onBack, onTeamsChanged });
    onTeamsChanged?.();
    requestAnimationFrame(() => {
      const tab = container.querySelector(`#team-tabs wa-tab[panel="${activePanel}"]`);
      if (tab) tab.click();
    });
  }

  // Invite form
  const inviteForm = container.querySelector("#invite-form");
  if (inviteForm) {
    inviteForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const emailInput = container.querySelector("#invite-email");
      const roleSelect = container.querySelector("#invite-role");
      const submitBtn = inviteForm.querySelector('wa-button[type="submit"]');
      const email = emailInput.value.trim();
      const role = roleSelect.value;

      if (!email) { showToast("Email is required", "warning"); return; }

      await withLoadingBtn(submitBtn, async () => {
        const result = await apiFetch(`/api/teams/${encodeURIComponent(id)}/invite`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, role }),
        });
        if (!result) return;
        const inviteUrl = `${location.origin}/invite/${result.data.token}`;
        showToast("Invite created! Share the link with the invitee.", "success");
        // Show a small inline result with the invite URL and copy button
        const inviteResult = document.createElement("div");
        inviteResult.className = "wa-stack wa-gap-xs invite-result";
        inviteResult.style.marginTop = "var(--wa-space-s)";
        inviteResult.innerHTML = `
          <wa-callout variant="success">
            <div class="wa-cluster wa-gap-s wa-align-items-center">
              <code style="word-break:break-all;">${escapeHtml(inviteUrl)}</code>
              <wa-copy-button value="${escapeAttr(inviteUrl)}" copy-label="Copy link" success-label="Copied!"><wa-icon slot="copy-icon" name="copy"></wa-icon><wa-icon slot="success-icon" name="check"></wa-icon></wa-copy-button>
            </div>
            <p class="wa-body-s wa-color-text-quiet" style="margin-top:var(--wa-space-2xs);">Share this link with ${escapeHtml(email)}. It expires in 7 days.</p>
          </wa-callout>
        `;
        // Insert the result right after the invite form
        const existingResult = inviteForm.parentElement.querySelector(".invite-result");
        if (existingResult) existingResult.remove();
        inviteForm.after(inviteResult);
      });
    });
  }

  // Change role buttons
  container.querySelectorAll(".change-role-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      const newRole = btn.dataset.currentRole === "admin" ? "member" : "admin";
      await withLoadingBtn(btn, async () => {
        const res = await apiFetch(`/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: newRole }),
        });
        if (!res) return;
        showToast("Role updated", "success");
        reloadPreservingTab();
      });
    });
  });

  // Remove member buttons
  container.querySelectorAll(".remove-member-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      const name = btn.dataset.name;
      if (!confirm(`Remove ${name} from this team?`)) return;
      await withLoadingBtn(btn, async () => {
        const res = await apiFetch(`/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
          method: "DELETE",
        });
        if (!res) return;
        showToast("Member removed", "success");
        reloadPreservingTab();
      });
    });
  });

  // Cancel invite buttons
  container.querySelectorAll(".cancel-invite-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const inviteId = btn.dataset.inviteId;
      await withLoadingBtn(btn, async () => {
        const res = await apiFetch(`/api/teams/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`, {
          method: "DELETE",
        });
        if (!res) return;
        showToast("Invite cancelled", "success");
        reloadPreservingTab();
      });
    });
  });

  // Edit team dialog
  if (isAdmin) {
    const editDialog = container.querySelector("#edit-team-dialog");
    container.querySelector("#edit-team-btn").addEventListener("click", () => { editDialog.open = true; });
    container.querySelector("#confirm-edit-team").addEventListener("click", async () => {
      const nameInput = container.querySelector("#edit-team-name");
      const name = nameInput.value.trim();
      if (!name) { showToast("Name is required", "warning"); return; }

      const confirmBtn = container.querySelector("#confirm-edit-team");
      await withLoadingBtn(confirmBtn, async () => {
        const res = await apiFetch(`/api/teams/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res) return;
        editDialog.open = false;
        showToast("Team updated", "success");
        reloadPreservingTab();
      });
    });

    // Delete team dialog
    const deleteDialog = container.querySelector("#delete-team-dialog");
    container.querySelector("#delete-team-btn").addEventListener("click", () => { deleteDialog.open = true; });
    container.querySelector("#confirm-delete-team").addEventListener("click", async () => {
      const confirmBtn = container.querySelector("#confirm-delete-team");
      await withLoadingBtn(confirmBtn, async () => {
        const res = await apiFetch(`/api/teams/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res) return;
        deleteDialog.open = false;
        showToast("Team deleted", "success");
        goBack();
      });
    });
  }

  // Leave team button (non-admin members)
  const leaveBtn = container.querySelector("#leave-team-btn");
  if (leaveBtn) {
    leaveBtn.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to leave this team?")) return;
      await withLoadingBtn(leaveBtn, async () => {
        const res = await apiFetch(`/api/teams/${encodeURIComponent(id)}/leave`, { method: "POST" });
        if (!res) return;
        showToast("You have left the team", "success");
        goBack();
      });
    });
  }
}
