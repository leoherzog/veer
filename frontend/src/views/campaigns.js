import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";

export async function renderCampaignsPanel(container) {
  container.innerHTML = `<div class="text-center" style="padding:var(--wa-space-3xl);"><wa-spinner></wa-spinner></div>`;

  let campaigns;
  try {
    const res = await fetch("/api/campaigns");
    if (res.status === 401) { window.location.href = "/login"; return; }
    if (!res.ok) { showToast("Failed to load campaigns", "danger"); return; }
    ({ data: campaigns } = await res.json());
  } catch {
    showToast("Failed to load campaigns", "danger");
    return;
  }

  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <div class="wa-split">
        <h1 class="wa-cluster wa-gap-xs wa-align-items-center">Your Campaigns <wa-icon id="campaigns-help" name="circle-question" variant="regular" class="text-subdued" style="font-size:0.6em;cursor:help;"></wa-icon></h1>
        <wa-button variant="brand" id="new-campaign-btn">
          <wa-icon slot="start" name="plus"></wa-icon>
          New Campaign
        </wa-button>
      </div>
      <wa-tooltip for="campaigns-help">Group related links together to track aggregate click stats across a promotion or project.</wa-tooltip>
      <div id="create-section" style="display:none;">
        <wa-card>
          <form id="campaign-form" class="wa-stack wa-gap-m">
            <wa-input name="name" label="Campaign Name" required placeholder="Summer Sale 2026"></wa-input>
            <wa-textarea name="description" label="Description (optional)" rows="2" placeholder="Group links for the summer promotion"></wa-textarea>
            <div class="wa-cluster wa-gap-s">
              <wa-button type="submit" variant="brand">Create Campaign</wa-button>
              <wa-button variant="neutral" id="cancel-create-btn">Cancel</wa-button>
            </div>
          </form>
        </wa-card>
      </div>
      <div id="campaigns-list"></div>
    </div>
  `;

  renderCampaignList(container.querySelector("#campaigns-list"), campaigns);

  const createSection = container.querySelector("#create-section");
  container.querySelector("#new-campaign-btn").addEventListener("click", () => {
    createSection.style.display = createSection.style.display === "none" ? "block" : "none";
  });
  container.querySelector("#cancel-create-btn").addEventListener("click", () => {
    createSection.style.display = "none";
  });

  container.querySelector("#campaign-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('wa-button[type="submit"]');
    btn.loading = true;
    btn.disabled = true;
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: e.target.querySelector('[name="name"]').value.trim(),
          description: e.target.querySelector('[name="description"]').value.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || "Failed to create campaign", "danger");
        return;
      }
      showToast("Campaign created", "success");
      renderCampaignsPanel(container);
    } catch {
      showToast("Network error", "danger");
    } finally {
      btn.loading = false;
      btn.disabled = false;
    }
  });
}

function renderCampaignList(container, campaigns) {
  if (!campaigns.length) {
    container.innerHTML = `
      <div class="wa-stack wa-gap-m wa-align-items-center" style="padding:var(--wa-space-3xl);">
        <wa-icon name="bullhorn" style="font-size:var(--wa-font-size-2xl);opacity:0.5;"></wa-icon>
        <p class="text-subdued">No campaigns yet. Create one to group your links.</p>
      </div>
    `;
    return;
  }
  container.innerHTML = `
    <div class="wa-stack wa-gap-m">
      ${campaigns.map(c => `
        <wa-card class="campaign-card" data-id="${escapeAttr(c.id)}">
          <div class="wa-split">
            <div class="wa-stack wa-gap-2xs">
              <strong>${escapeHtml(c.name)}</strong>
              ${c.description ? `<span class="wa-body-s text-subdued">${escapeHtml(c.description)}</span>` : ""}
            </div>
            <wa-badge variant="neutral" pill>${c.linkCount ?? 0} link${(c.linkCount ?? 0) === 1 ? "" : "s"}</wa-badge>
          </div>
        </wa-card>
      `).join("")}
    </div>
  `;
  container.querySelectorAll(".campaign-card").forEach(card => {
    card.addEventListener("click", () => navigate(`/campaigns/${card.dataset.id}`));
  });
}
