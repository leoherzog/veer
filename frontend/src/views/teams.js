import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, emptyState, delegateClick, afterClose } from "../lib/ui.js";

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
        : `<div id="team-cards" class="wa-grid wa-gap-m" style="--min-column-size:280px;">
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
        <form id="create-team-form">
          <wa-input name="name" label="Team Name" placeholder="My Team" required pattern=".*\\S.*" title="Name is required" autofocus></wa-input>
        </form>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" type="submit" form="create-team-form" id="confirm-create-team">Create</wa-button>
      </wa-dialog>
    </div>
  `;

  // The panel element is reused for every list and detail render, so the
  // delegates bind to the grid this render created.
  const cards = container.querySelector("#team-cards");
  if (cards) {
    delegateClick(cards, ".team-card", (card) => onTeamSelect(card.dataset.id));
    cards.addEventListener("keydown", (e) => {
      const card = e.target.closest(".team-card");
      if (!card || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      onTeamSelect(card.dataset.id);
    });
  }

  const dialog = container.querySelector("#create-team-dialog");
  const form = container.querySelector("#create-team-form");
  const confirmBtn = container.querySelector("#confirm-create-team");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = String(new FormData(form).get("name") ?? "").trim();
    await withLoadingBtn(confirmBtn, async () => {
      const result = await apiFetch("/api/teams", { method: "POST", json: { name } });
      if (!result) return;
      showToast("Team created", "success");
      afterClose(dialog, () => onTeamSelect(result.data.id));
    });
  });
}
