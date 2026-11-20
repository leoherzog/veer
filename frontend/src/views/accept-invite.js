import { navigate } from "../router.js";
import { showToast } from "../components/toast.js";
import { escapeHtml } from "../lib/escape.js";

export async function renderAcceptInvite(container, { token }) {
  /** Render a failure with plain-text `body` and its trusted `action` markup. */
  const showFailure = ({ title, body, action }) => {
    container.innerHTML = `
      <div class="wa-danger wa-stack wa-align-items-center wa-gap-m wa-text-center">
        <wa-icon name="circle-xmark" class="wa-font-size-3xl" style="color: var(--wa-color-on-quiet);"></wa-icon>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(body)}</p>
        ${action}
      </div>
    `;
  };

  container.innerHTML = `<div class="wa-stack wa-align-items-center"><wa-spinner></wa-spinner><p>Accepting invite...</p></div>`;

  let res, result;
  try {
    res = await fetch("/api/teams/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    result = await res.json().catch(() => ({}));
  } catch {
    showFailure({
      title: "Network Error",
      body: "Please check your connection and try again.",
      action: `<wa-button variant="brand" id="retry-invite">Retry</wa-button>`,
    });
    container.querySelector("#retry-invite").addEventListener("click", () => renderAcceptInvite(container, { token }));
    return;
  }

  if (!res.ok) {
    showFailure({
      title: "Invite Failed",
      body: result.error || "Unable to accept this invite.",
      action: `<wa-button variant="brand" href="/teams" data-link>Go to Teams</wa-button>`,
    });
    return;
  }

  const { teamId, team } = result.data;
  showToast(`You've joined ${team?.name || "the team"}`, "success");
  // Replace the invite URL so Back cannot re-post the spent token. A view the
  // user already left must not pull them back.
  if (container.isConnected) navigate(`/teams/${encodeURIComponent(teamId)}`, true);
}
