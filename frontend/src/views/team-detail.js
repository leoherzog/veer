import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import {
  SPINNER, apiFetch, withLoadingBtn, bindConfirmDialog, renderTable, relativeTime,
  errorCallout, loadTableSection, delegateClick, secretCallout, afterClose,
} from "../lib/ui.js";

function roleBadge(role) {
  return `<wa-badge variant="${role === "admin" ? "brand" : "neutral"}" pill>${escapeHtml(role)}</wa-badge>`;
}

/** A member row. Admins get an actions cell, empty on their own row. */
function renderMemberRow(member, { isAdmin, currentUserId }) {
  const name = member.name || member.email;
  const actions = isAdmin && member.userId !== currentUserId ? `
    <div class="wa-cluster wa-gap-2xs">
      <wa-button size="s" variant="neutral" appearance="outlined" class="change-role-btn" data-user-id="${escapeAttr(member.userId)}" data-current-role="${escapeAttr(member.role)}">
        <wa-icon slot="start" name="arrows-rotate"></wa-icon>
        ${member.role === "admin" ? "Demote" : "Promote"}
      </wa-button>
      <wa-button size="s" variant="danger" appearance="outlined" class="remove-member-btn" data-dialog="open remove-member-dialog" data-user-id="${escapeAttr(member.userId)}" data-name="${escapeAttr(name)}">
        <wa-icon slot="start" name="user-minus"></wa-icon>
        Remove
      </wa-button>
    </div>
  ` : "";
  return `
    <tr>
      <td>
        <div class="wa-cluster wa-gap-xs">
          <wa-avatar class="row-avatar" image="${escapeAttr(member.image)}" label="${escapeAttr(name)}"></wa-avatar>
          ${escapeHtml(name)}
        </div>
      </td>
      <td>${escapeHtml(member.email)}</td>
      <td>${roleBadge(member.role)}</td>
      ${isAdmin ? `<td>${actions}</td>` : ""}
    </tr>
  `;
}

function inviteUrl(token) {
  return `${location.origin}/invite/${token}`;
}

function renderInviteRow(invite) {
  return `
    <tr>
      <td>${escapeHtml(invite.email)}</td>
      <td>${roleBadge(invite.role)}</td>
      <td>${relativeTime(invite.expiresAt)}</td>
      <td>
        <div class="wa-cluster wa-gap-2xs">
          <wa-copy-button value="${escapeAttr(inviteUrl(invite.token))}" copy-label="Copy invite link"></wa-copy-button>
          <wa-button size="s" variant="danger" appearance="outlined" class="cancel-invite-btn" data-invite-id="${escapeAttr(invite.id)}">
            <wa-icon slot="start" name="xmark"></wa-icon>
            Cancel
          </wa-button>
        </div>
      </td>
    </tr>
  `;
}

/** Header, tabs and dialogs for one team. Admin-only controls and dialogs render only for admins. */
function renderShell(team, isAdmin, activeTab) {
  const name = escapeHtml(team.name);
  return `
    <div class="wa-stack wa-gap-l">
      <div class="wa-split">
        <div class="wa-cluster wa-gap-s">
          <wa-button variant="neutral" appearance="plain" size="s" id="back-to-teams">
            <wa-icon name="arrow-left" label="Back to teams"></wa-icon>
          </wa-button>
          <h1>${name}</h1>
        </div>
        <div class="wa-cluster wa-gap-xs">
          ${isAdmin ? `
            <wa-button variant="neutral" appearance="outlined" data-dialog="open edit-team-dialog">
              <wa-icon slot="start" name="pen-to-square"></wa-icon>
              Edit
            </wa-button>
            <wa-button variant="danger" appearance="outlined" data-dialog="open delete-team-dialog">
              <wa-icon slot="start" name="trash"></wa-icon>
              Delete
            </wa-button>
          ` : ""}
          <wa-button variant="danger" appearance="outlined" data-dialog="open leave-team-dialog">
            <wa-icon slot="start" name="right-from-bracket"></wa-icon>
            Leave Team
          </wa-button>
        </div>
      </div>

      <wa-tab-group without-scroll-controls id="team-tabs" active="${escapeAttr(activeTab)}">
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
          <div class="wa-stack wa-gap-m">
            ${isAdmin ? `
              <wa-card>
                <h3 slot="header">Invite Member</h3>
                <div class="wa-stack wa-gap-m">
                  <form id="invite-form" class="wa-cluster wa-gap-s wa-align-items-end">
                    <wa-input name="email" label="Email" type="email" placeholder="user@example.com" required></wa-input>
                    <wa-select name="role" label="Role" value="member">
                      <wa-option value="member">Member</wa-option>
                      <wa-option value="admin">Admin</wa-option>
                    </wa-select>
                    <wa-button type="submit" variant="brand" size="s">
                      <wa-icon slot="start" name="paper-plane"></wa-icon>
                      Invite
                    </wa-button>
                  </form>
                  <div id="invite-result" hidden></div>
                </div>
              </wa-card>
            ` : ""}
            <wa-card>
              <h3 slot="header">Members</h3>
              <div id="members-list"></div>
            </wa-card>
          </div>
        </wa-tab-panel>

        ${isAdmin ? `
          <wa-tab-panel name="invites">
            <wa-card>
              <h3 slot="header">Pending Invites</h3>
              <div id="invites-list"></div>
            </wa-card>
          </wa-tab-panel>
        ` : ""}
      </wa-tab-group>

      ${isAdmin ? `
        <wa-dialog id="edit-team-dialog" label="Edit Team" light-dismiss>
          <form id="edit-team-form">
            <wa-input name="name" label="Team Name" value="${escapeAttr(team.name)}" required pattern=".*\\S.*" title="Name is required" autofocus></wa-input>
          </form>
          <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
          <wa-button slot="footer" variant="brand" type="submit" form="edit-team-form" id="confirm-edit-team">Save</wa-button>
        </wa-dialog>

        <wa-dialog id="delete-team-dialog" label="Delete Team" light-dismiss>
          <p>Are you sure you want to delete <strong>${name}</strong>? This cannot be undone. All team links will be unlinked from the team.</p>
          <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
          <wa-button slot="footer" variant="danger" id="confirm-delete-team">Delete</wa-button>
        </wa-dialog>

        <wa-dialog id="remove-member-dialog" label="Remove Member" light-dismiss>
          <p>Are you sure you want to remove <strong id="remove-member-name"></strong> from this team?</p>
          <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
          <wa-button slot="footer" variant="danger" id="confirm-remove-member">Remove</wa-button>
        </wa-dialog>
      ` : ""}

      <wa-dialog id="leave-team-dialog" label="Leave Team" light-dismiss>
        <p>Are you sure you want to leave <strong>${name}</strong>?</p>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="danger" id="confirm-leave-team">Leave Team</wa-button>
      </wa-dialog>
    </div>
  `;
}

export async function renderTeamDetail(container, { id }, currentUser, { onBack, onTeamsChanged, activeTab = "members" } = {}) {
  container.innerHTML = SPINNER;
  const teamPath = `/api/teams/${encodeURIComponent(id)}`;

  const teamResult = await apiFetch(teamPath);
  if (!teamResult) {
    container.innerHTML = `
      <div class="wa-stack wa-gap-m">
        ${errorCallout("Team not found or you are no longer a member.")}
        <div>
          <wa-button variant="neutral" appearance="outlined" id="back-to-teams">
            <wa-icon slot="start" name="arrow-left"></wa-icon>
            Back to teams
          </wa-button>
        </div>
      </div>
    `;
    container.querySelector("#back-to-teams").addEventListener("click", () => onBack());
    return;
  }
  const { data: team } = teamResult;
  const isAdmin = team.members.some((m) => m.userId === currentUser.id && m.role === "admin");

  container.innerHTML = renderShell(team, isAdmin, activeTab);
  container.querySelector("#back-to-teams").addEventListener("click", () => onBack());

  // Re-render the whole view in place, keeping the open tab.
  const reload = () => renderTeamDetail(container, { id }, currentUser, {
    onBack,
    onTeamsChanged,
    activeTab: container.querySelector("#team-tabs")?.active || activeTab,
  });

  const membersList = container.querySelector("#members-list");
  membersList.innerHTML = renderTable({
    label: "Team members",
    columns: ["Name", "Email", "Role", ...(isAdmin ? ["Actions"] : [])],
    rows: team.members.map((m) => renderMemberRow(m, { isAdmin, currentUserId: currentUser.id })),
  });

  bindConfirmDialog({
    dialog: container.querySelector("#leave-team-dialog"),
    confirmBtn: container.querySelector("#confirm-leave-team"),
    onConfirm: async () => {
      const res = await apiFetch(`${teamPath}/leave`, { method: "POST" });
      if (!res) return false;
      showToast("You have left the team", "success");
      onBack();
    },
  });

  if (!isAdmin) return;

  // ── Admin controls ──────────────────────────────────────────────

  const invitesList = container.querySelector("#invites-list");
  const loadInvites = () => loadTableSection(invitesList, {
    url: `${teamPath}/invites`,
    label: "Pending invites",
    headers: ["Email", "Role", "Expires", "Actions"],
    renderRow: renderInviteRow,
    empty: "No pending invites.",
    error: "Failed to load invites.",
  });
  loadInvites();

  const inviteForm = container.querySelector("#invite-form");
  const inviteBtn = inviteForm.querySelector('wa-button[type="submit"]');
  inviteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = new FormData(inviteForm);
    const email = String(fields.get("email") ?? "").trim();
    const role = fields.get("role");

    await withLoadingBtn(inviteBtn, async () => {
      const result = await apiFetch(`${teamPath}/invite`, { method: "POST", json: { email, role } });
      if (!result) return;
      showToast("Invite created! Share the link with the invitee.", "success");
      const resultEl = container.querySelector("#invite-result");
      resultEl.innerHTML = secretCallout({
        variant: "success",
        value: inviteUrl(result.data.token),
        copyLabel: "Copy link",
        after: `<p class="wa-body-s wa-color-text-quiet">Share this link with ${escapeHtml(email)}. It expires ${relativeTime(result.data.expiresAt)}.</p>`,
      });
      resultEl.hidden = false;
      inviteForm.reset();
      loadInvites();
    });
  });

  delegateClick(invitesList, ".cancel-invite-btn", (btn) => withLoadingBtn(btn, async () => {
    const res = await apiFetch(`${teamPath}/invites/${encodeURIComponent(btn.dataset.inviteId)}`, { method: "DELETE" });
    if (!res) return;
    showToast("Invite cancelled", "success");
    loadInvites();
  }));

  delegateClick(membersList, ".change-role-btn", (btn) => withLoadingBtn(btn, async () => {
    const role = btn.dataset.currentRole === "admin" ? "member" : "admin";
    const res = await apiFetch(`${teamPath}/members/${encodeURIComponent(btn.dataset.userId)}`, { method: "PATCH", json: { role } });
    if (!res) return;
    showToast("Role updated", "success");
    reload();
  }));

  const removeMemberDialog = container.querySelector("#remove-member-dialog");
  delegateClick(membersList, ".remove-member-btn", (btn) => {
    removeMemberDialog.dataset.userId = btn.dataset.userId;
    container.querySelector("#remove-member-name").textContent = btn.dataset.name;
  });

  bindConfirmDialog({
    dialog: removeMemberDialog,
    confirmBtn: container.querySelector("#confirm-remove-member"),
    onConfirm: async () => {
      const res = await apiFetch(`${teamPath}/members/${encodeURIComponent(removeMemberDialog.dataset.userId)}`, { method: "DELETE" });
      if (!res) return false;
      showToast("Member removed", "success");
      reload();
    },
  });

  const editDialog = container.querySelector("#edit-team-dialog");
  const editForm = container.querySelector("#edit-team-form");
  const saveBtn = container.querySelector("#confirm-edit-team");
  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = String(new FormData(editForm).get("name") ?? "").trim();
    await withLoadingBtn(saveBtn, async () => {
      const res = await apiFetch(teamPath, { method: "PUT", json: { name } });
      if (!res) return;
      showToast("Team updated", "success");
      afterClose(editDialog, () => {
        reload();
        onTeamsChanged?.();
      });
    });
  });

  bindConfirmDialog({
    dialog: container.querySelector("#delete-team-dialog"),
    confirmBtn: container.querySelector("#confirm-delete-team"),
    onConfirm: async () => {
      const res = await apiFetch(teamPath, { method: "DELETE" });
      if (!res) return false;
      showToast("Team deleted", "success");
      onBack();
    },
  });
}
