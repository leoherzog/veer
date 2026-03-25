import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";

export async function renderTeamsPanel(container, { teams = null, currentUser = null, onTeamSelect, onTeamsChanged } = {}) {
  container.innerHTML = `<div class="wa-stack wa-align-items-center centered-state"><wa-spinner></wa-spinner></div>`;

  if (teams === null) {
    try {
      const res = await fetch("/api/teams");
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) { showToast("Failed to load teams", "danger"); return; }
      ({ data: teams } = await res.json());
    } catch {
      showToast("Failed to load teams", "danger");
      return;
    }
  }

  container.innerHTML = `
    <div class="teams-view wa-stack wa-gap-l">
      <div class="wa-split">
        <h1>Teams</h1>
        <wa-button variant="brand" id="create-team-btn">
          <wa-icon slot="start" name="plus"></wa-icon>
          Create Team
        </wa-button>
      </div>

      <div id="teams-grid">
        ${teams.length === 0
          ? `<div class="wa-stack wa-gap-m wa-align-items-center centered-state">
              <wa-icon name="people-group" class="wa-font-size-2xl wa-color-text-quiet"></wa-icon>
              <p>You're not a member of any teams yet. Create one to get started.</p>
            </div>`
          : `<div class="wa-grid wa-gap-m" style="--min-column-size:280px;">
              ${teams.map(t => `
                <wa-card class="team-card" data-id="${escapeAttr(t.id)}">
                  <div class="wa-stack wa-gap-s">
                    <div class="wa-split">
                      <strong>${escapeHtml(t.name)}</strong>
                      <wa-badge variant="neutral" pill>/${escapeHtml(t.slug)}</wa-badge>
                    </div>
                    <div class="wa-cluster wa-gap-s">
                      <span class="wa-body-s wa-color-text-quiet">
                        <wa-icon name="users" class="wa-font-size-xs"></wa-icon>
                        ${Number(t.memberCount) || 0} member${(Number(t.memberCount) || 0) !== 1 ? "s" : ""}
                      </span>
                      <span class="wa-body-s wa-color-text-quiet">
                        <wa-icon name="link" class="wa-font-size-xs"></wa-icon>
                        ${Number(t.linkCount) || 0} link${(Number(t.linkCount) || 0) !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                </wa-card>
              `).join("")}
            </div>`
        }
      </div>

      <wa-dialog id="create-team-dialog" label="Create Team">
        <div class="wa-stack wa-gap-m">
          <wa-input id="team-name-input" label="Team Name" placeholder="My Team" required></wa-input>
          <wa-input id="team-slug-input" label="Team Slug" placeholder="my-team" required>
            <span slot="hint">Used in URLs. Lowercase letters, numbers, and hyphens only.</span>
          </wa-input>
        </div>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" id="confirm-create-team">Create</wa-button>
      </wa-dialog>
    </div>
  `;

  // Navigate to team detail on card click
  container.querySelectorAll(".team-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (onTeamSelect) {
        onTeamSelect(card.dataset.id);
      } else {
        navigate(`/teams/${card.dataset.id}`);
      }
    });
  });

  // Create team dialog
  const dialog = container.querySelector("#create-team-dialog");
  const createBtn = container.querySelector("#create-team-btn");
  const confirmBtn = container.querySelector("#confirm-create-team");
  const nameInput = container.querySelector("#team-name-input");
  const slugInput = container.querySelector("#team-slug-input");

  createBtn.addEventListener("click", () => { dialog.open = true; });

  // Auto-generate slug from name
  nameInput.addEventListener("input", () => {
    const slug = nameInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    slugInput.value = slug;
  });

  confirmBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const slug = slugInput.value.trim();
    if (!name || !slug) { showToast("Name and slug are required", "warning"); return; }

    confirmBtn.loading = true;
    confirmBtn.disabled = true;
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug }),
      });
      const result = await res.json();
      if (!res.ok) {
        showToast(result.message || result.error || "Failed to create team", "danger");
        return;
      }
      dialog.open = false;
      showToast("Team created", "success");
      onTeamsChanged?.();
      if (onTeamSelect) {
        onTeamSelect(result.data.id);
      } else {
        navigate(`/teams/${result.data.id}`);
      }
    } catch {
      showToast("Network error", "danger");
    } finally {
      confirmBtn.loading = false;
      confirmBtn.disabled = false;
    }
  });
}

// Backward-compat wrapper
export async function renderTeams(container) {
  return renderTeamsPanel(container, {
    onTeamSelect: (id) => navigate(`/teams/${id}`),
  });
}
