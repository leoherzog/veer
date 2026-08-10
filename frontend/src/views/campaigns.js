import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { SPINNER, apiFetch, withLoadingBtn, emptyState } from "../lib/ui.js";

export async function renderCampaignsPanel(container) {
  container.innerHTML = SPINNER;

  const result = await apiFetch("/api/campaigns");
  if (!result) return;
  const { data: campaigns } = result;

  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <div class="wa-split">
        <h1 class="wa-cluster wa-gap-xs wa-align-items-center">Your Campaigns <wa-icon id="campaigns-help" name="circle-question" variant="solid" class="wa-color-text-quiet wa-font-size-s" style="cursor:help;"></wa-icon></h1>
        <wa-button variant="brand" id="new-campaign-btn" data-dialog="open new-campaign-dialog">
          <wa-icon slot="start" name="plus"></wa-icon>
          New Campaign
        </wa-button>
      </div>
      <wa-tooltip for="campaigns-help">Group related links together to track aggregate click stats across a promotion or project.</wa-tooltip>
      <div id="campaigns-list"></div>

      <wa-dialog id="new-campaign-dialog" label="New Campaign" light-dismiss>
        <form id="campaign-form" class="wa-stack wa-gap-m">
          <wa-input name="name" label="Campaign Name" required placeholder="Summer Sale 2026"></wa-input>
          <wa-textarea name="description" label="Description (optional)" rows="2" placeholder="Group links for the summer promotion"></wa-textarea>
        </form>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" type="submit" form="campaign-form" id="create-campaign-btn">Create Campaign</wa-button>
      </wa-dialog>
    </div>
  `;

  renderCampaignList(container.querySelector("#campaigns-list"), campaigns);

  const createBtn = container.querySelector("#create-campaign-btn");
  container.querySelector("#campaign-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoadingBtn(createBtn, async () => {
      const res = await apiFetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: e.target.querySelector('[name="name"]').value.trim(),
          description: e.target.querySelector('[name="description"]').value.trim() || null,
        }),
      });
      if (!res) return;
      showToast("Campaign created", "success");
      renderCampaignsPanel(container);
    });
  });
}

function renderCampaignList(container, campaigns) {
  if (!campaigns.length) {
    container.innerHTML = emptyState("bullhorn", "No campaigns yet. Create one to group your links.");
    return;
  }
  container.innerHTML = `
    <div class="wa-stack wa-gap-m">
      ${campaigns.map(c => `
        <a href="/campaigns/${escapeAttr(c.id)}" data-link class="wa-link-plain">
          <wa-card >
            <div class="wa-split">
              <div class="wa-stack wa-gap-2xs">
                <strong>${escapeHtml(c.name)}</strong>
                ${c.description ? `<span class="wa-body-s wa-color-text-quiet">${escapeHtml(c.description)}</span>` : ""}
              </div>
              <wa-badge variant="neutral" pill>${c.linkCount ?? 0} link${(c.linkCount ?? 0) === 1 ? "" : "s"}</wa-badge>
            </div>
          </wa-card>
        </a>
      `).join("")}
    </div>
  `;
}
