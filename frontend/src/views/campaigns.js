import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { SPINNER, apiFetch, withLoadingBtn, emptyState, errorCallout, afterClose } from "../lib/ui.js";

/** Name and description controls shared by the campaign create and edit forms. */
export function campaignFields(campaign = null) {
  return `
    <wa-input name="name" label="Campaign Name" required placeholder="Summer Sale 2026" value="${escapeAttr(campaign?.name)}"></wa-input>
    <wa-textarea name="description" label="Description (optional)" rows="2" placeholder="Group links for the summer promotion" value="${escapeAttr(campaign?.description)}"></wa-textarea>
  `;
}

/** The POST/PUT body for a form built from `campaignFields`. */
export function campaignBody(form) {
  const fields = new FormData(form);
  return {
    name: String(fields.get("name") ?? "").trim(),
    description: String(fields.get("description") ?? "").trim() || null,
  };
}

export async function renderCampaignsPanel(container) {
  // A refresh keeps the current markup until the new data lands.
  if (!container.childElementCount) container.innerHTML = SPINNER;

  const result = await apiFetch("/api/campaigns");
  if (!result) {
    container.innerHTML = errorCallout("Failed to load campaigns.");
    return;
  }
  const { data: campaigns } = result;

  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <div class="wa-split">
        <h1>Your Campaigns <wa-icon id="campaigns-help" name="circle-question" label="About campaigns" class="wa-color-text-quiet heading-help"></wa-icon></h1>
        <wa-button variant="brand" id="new-campaign-btn" data-dialog="open new-campaign-dialog">
          <wa-icon slot="start" name="plus"></wa-icon>
          New Campaign
        </wa-button>
      </div>
      <wa-tooltip for="campaigns-help">Group related links together to track aggregate click stats across a promotion or project.</wa-tooltip>
      <div id="campaigns-list"></div>

      <wa-dialog id="new-campaign-dialog" label="New Campaign" light-dismiss>
        <form id="campaign-form" class="wa-stack wa-gap-m">
          ${campaignFields()}
        </form>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" type="submit" form="campaign-form" id="create-campaign-btn">Create Campaign</wa-button>
      </wa-dialog>
    </div>
  `;

  renderCampaignList(container.querySelector("#campaigns-list"), campaigns);

  const dialog = container.querySelector("#new-campaign-dialog");
  const createBtn = container.querySelector("#create-campaign-btn");
  container.querySelector("#campaign-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoadingBtn(createBtn, async () => {
      const res = await apiFetch("/api/campaigns", { method: "POST", json: campaignBody(e.target) });
      if (!res) return;
      showToast("Campaign created", "success");
      afterClose(dialog, () => renderCampaignsPanel(container));
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
          <wa-card>
            <div class="wa-split">
              <div class="wa-stack wa-gap-2xs">
                <strong>${escapeHtml(c.name)}</strong>
                ${c.description ? `<span class="wa-body-s wa-color-text-quiet">${escapeHtml(c.description)}</span>` : ""}
              </div>
              <wa-badge variant="neutral" pill>${c.linkCount} link${c.linkCount === 1 ? "" : "s"}</wa-badge>
            </div>
          </wa-card>
        </a>
      `).join("")}
    </div>
  `;
}
