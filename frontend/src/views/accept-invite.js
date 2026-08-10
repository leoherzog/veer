import { navigate } from "../router.js";
import { escapeHtml } from "../lib/escape.js";

export async function renderAcceptInvite(container, { token }) {
  /** Render a terminal state and wire its action button. `body` is trusted HTML. */
  const showState = ({ icon, tone, title, body, action, onAction }) => {
    container.innerHTML = `
      <div class="wa-${tone} wa-stack wa-align-items-center wa-gap-m centered-state">
        <wa-icon name="${icon}" class="wa-font-size-3xl" style="color: var(--wa-color-on-quiet);"></wa-icon>
        <h2>${escapeHtml(title)}</h2>
        <p>${body}</p>
        <wa-button variant="brand" id="state-action">${escapeHtml(action)}</wa-button>
      </div>
    `;
    container.querySelector("#state-action")?.addEventListener("click", onAction);
  };

  container.innerHTML = `<div class="wa-stack wa-align-items-center"><wa-spinner></wa-spinner><p>Accepting invite...</p></div>`;

  try {
    const res = await fetch("/api/teams/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const result = await res.json();

    if (!res.ok) {
      showState({
        icon: "circle-xmark",
        tone: "danger",
        title: "Invite Failed",
        body: escapeHtml(result.error || "Unable to accept this invite."),
        action: "Go to Teams",
        onAction: () => navigate("/teams"),
      });
      return;
    }

    const teamName = result.data?.team?.name || "the team";
    showState({
      icon: "circle-check",
      tone: "success",
      title: "Welcome!",
      body: `You've joined <strong>${escapeHtml(teamName)}</strong>.`,
      action: "View Team",
      onAction: () => navigate(`/teams/${result.data.teamId}`),
    });
  } catch {
    showState({
      icon: "circle-xmark",
      tone: "danger",
      title: "Network Error",
      body: "Please check your connection and try again.",
      action: "Retry",
      onAction: () => renderAcceptInvite(container, { token }),
    });
  }
}
