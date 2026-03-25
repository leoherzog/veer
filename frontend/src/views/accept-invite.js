import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeHtml } from "../lib/escape.js";

export async function renderAcceptInvite(container, { token }) {
  container.innerHTML = `<div class="wa-stack wa-align-items-center centered-state"><wa-spinner></wa-spinner><p>Accepting invite...</p></div>`;

  try {
    const res = await fetch("/api/teams/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const result = await res.json();

    if (!res.ok) {
      container.innerHTML = `
        <div class="wa-stack wa-align-items-center wa-gap-m centered-state">
          <wa-icon name="circle-xmark" class="wa-font-size-3xl wa-color-text-danger"></wa-icon>
          <h2>Invite Failed</h2>
          <p>${escapeHtml(result.error || "Unable to accept this invite.")}</p>
          <wa-button variant="brand" id="go-teams">Go to Teams</wa-button>
        </div>
      `;
      container.querySelector("#go-teams")?.addEventListener("click", () => navigate("/teams"));
      return;
    }

    const teamName = result.data?.team?.name || "the team";
    container.innerHTML = `
      <div class="wa-stack wa-align-items-center wa-gap-m centered-state">
        <wa-icon name="circle-check" class="wa-font-size-3xl wa-color-text-success"></wa-icon>
        <h2>Welcome!</h2>
        <p>You've joined <strong>${escapeHtml(teamName)}</strong>.</p>
        <wa-button variant="brand" id="go-team">View Team</wa-button>
      </div>
    `;
    container.querySelector("#go-team")?.addEventListener("click", () => navigate(`/teams/${result.data.teamId}`));
  } catch {
    container.innerHTML = `
      <div class="wa-stack wa-align-items-center wa-gap-m centered-state">
        <wa-icon name="circle-xmark" class="wa-font-size-3xl wa-color-text-danger"></wa-icon>
        <h2>Network Error</h2>
        <p>Please check your connection and try again.</p>
        <wa-button variant="brand" id="retry">Retry</wa-button>
      </div>
    `;
    container.querySelector("#retry")?.addEventListener("click", () => renderAcceptInvite(container, { token }));
  }
}
