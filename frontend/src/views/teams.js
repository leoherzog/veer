import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, emptyState } from "../lib/ui.js";

export function renderTeamsPanel(container, { teams, onTeamSelect }) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <div class="wa-split">
        <h1>Teams</h1>
        <wa-button variant="brand" id="create-team-btn" data-dialog="open create-team-dialog">
          <wa-icon slot="start" name="plus"></wa-icon>
          Create Team
        </wa-button>
      </div>

        ${teams.length === 0
          ? emptyState("people-group", "You're not a member of any teams yet. Create one to get started.")
          : `<div class="wa-grid wa-gap-m" style="--min-column-size:280px;">
              ${teams.map(t => `
                <wa-card class="team-card" data-id="${escapeAttr(t.id)}" role="button" tabindex="0" aria-label="Open team ${escapeAttr(t.name)}">
                  <div class="wa-stack wa-gap-s">
                    <strong>${escapeHtml(t.name)}</strong>
                    <div class="wa-cluster wa-gap-s">
                      <span class="wa-body-s wa-color-text-quiet">
                        <wa-icon name="users" class="wa-font-size-xs"></wa-icon>
                        ${t.memberCount} member${t.memberCount === 1 ? "" : "s"}
                      </span>
                      <span class="wa-body-s wa-color-text-quiet">
                        <wa-icon name="link" class="wa-font-size-xs"></wa-icon>
                        ${t.linkCount} link${t.linkCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                </wa-card>
              `).join("")}
            </div>`
        }

      <wa-dialog id="create-team-dialog" label="Create Team" light-dismiss>
        <wa-input id="team-name-input" label="Team Name" placeholder="My Team" required></wa-input>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" id="confirm-create-team">Create</wa-button>
      </wa-dialog>
    </div>
  `;

  container.querySelectorAll(".team-card").forEach((card) => {
    card.addEventListener("click", () => {
      onTeamSelect(card.dataset.id);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onTeamSelect(card.dataset.id);
    });
  });

  const dialog = container.querySelector("#create-team-dialog");
  const confirmBtn = container.querySelector("#confirm-create-team");
  const nameInput = container.querySelector("#team-name-input");

  confirmBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast("Team name is required", "warning"); return; }

    await withLoadingBtn(confirmBtn, async () => {
      const result = await apiFetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!result) return;
      dialog.open = false;
      showToast("Team created", "success");
      onTeamSelect(result.data.id);
    });
  });
}
