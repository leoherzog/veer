import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { SPINNER, apiFetch, withLoadingBtn, bindConfirmDialog, shortUrl, emptyState, statCard, renderTable } from "../lib/ui.js";
import { fetchJSON } from "../lib/stats-common.js";

export async function renderCampaignDetail(container, { id }) {
  // A refresh keeps the current markup until the new data lands, so adding or
  // removing a link neither flashes the spinner nor resets the scroll position.
  if (!container.childElementCount) container.innerHTML = SPINNER;

  const campResult = await apiFetch(`/api/campaigns/${id}`);
  if (!campResult) return;
  const { data: campaign } = campResult;
  const campaignLinks = campaign.links || [];

  // Aggregate stats cover a 30-day window, unlike the lifetime per-link totals
  // below. Best-effort — no toast on failure.
  const recentClicks = await fetchJSON(`/api/campaigns/${id}/stats`).then((r) => r.data?.totalClicks ?? 0, () => 0);

  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <div class="wa-split">
        <div class="wa-cluster wa-gap-s wa-align-items-center">
          <wa-button variant="neutral" appearance="plain" pill href="/campaigns" data-link aria-label="Back to campaigns">
            <wa-icon name="arrow-left"></wa-icon>
          </wa-button>
          <h1>${escapeHtml(campaign.name)}</h1>
        </div>
        <div class="wa-cluster wa-gap-xs">
          <wa-button variant="neutral" data-dialog="open edit-campaign-dialog">
            <wa-icon slot="start" name="pen-to-square"></wa-icon>
            Edit
          </wa-button>
          <wa-button variant="danger" appearance="outlined" data-dialog="open delete-campaign-dialog">
            <wa-icon slot="start" name="trash"></wa-icon>
            Delete
          </wa-button>
        </div>
      </div>

      ${campaign.description ? `<p class="wa-color-text-quiet">${escapeHtml(campaign.description)}</p>` : ""}

      <div class="wa-grid wa-gap-m">
        ${statCard("Links", `<wa-format-number value="${campaignLinks.length}"></wa-format-number>`)}
        ${statCard("Clicks (30 days)", `<wa-format-number value="${recentClicks}"></wa-format-number>`)}
      </div>

      <div class="wa-split">
        <h2>Links</h2>
        <wa-button variant="brand" size="s" id="add-links-btn">
          <wa-icon slot="start" name="plus"></wa-icon>
          Add Links
        </wa-button>
      </div>
      <div id="campaign-links-list"></div>

      <wa-dialog id="add-links-dialog" label="Add Links to Campaign" light-dismiss style="--width:600px;">
        <div id="available-links-list" class="wa-stack wa-gap-s"></div>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Close</wa-button>
      </wa-dialog>

      <wa-dialog id="edit-campaign-dialog" label="Edit Campaign" light-dismiss>
        <form id="edit-campaign-form" class="wa-stack wa-gap-m">
          <wa-input name="name" label="Campaign Name" required value="${escapeAttr(campaign.name)}"></wa-input>
          <wa-textarea name="description" label="Description (optional)" rows="2" value="${escapeAttr(campaign.description || "")}"></wa-textarea>
        </form>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="brand" type="submit" form="edit-campaign-form" id="save-campaign-btn">Save Changes</wa-button>
      </wa-dialog>

      <wa-dialog id="delete-campaign-dialog" label="Delete Campaign" light-dismiss>
        <p>Are you sure you want to delete <strong>${escapeHtml(campaign.name)}</strong>? Links will not be deleted, only unlinked from the campaign.</p>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="danger" id="confirm-delete-campaign">Delete</wa-button>
      </wa-dialog>
    </div>
  `;

  renderCampaignLinks(container.querySelector("#campaign-links-list"), campaignLinks, id, container);

  const saveBtn = container.querySelector("#save-campaign-btn");
  container.querySelector("#edit-campaign-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoadingBtn(saveBtn, async () => {
      const res = await apiFetch(`/api/campaigns/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: e.target.querySelector('[name="name"]').value.trim(),
          description: e.target.querySelector('[name="description"]').value.trim() || null,
        }),
      });
      if (!res) return;
      showToast("Campaign updated", "success");
      renderCampaignDetail(container, { id });
    });
  });

  bindConfirmDialog({
    dialog: container.querySelector("#delete-campaign-dialog"),
    confirmBtn: container.querySelector("#confirm-delete-campaign"),
    onConfirm: async () => {
      const res = await apiFetch(`/api/campaigns/${id}`, { method: "DELETE" });
      if (!res) return false;
      showToast("Campaign deleted", "success");
      navigate("/campaigns");
    },
  });

  const dialog = container.querySelector("#add-links-dialog");
  container.querySelector("#add-links-btn").addEventListener("click", async () => {
    dialog.open = true;
    await loadAvailableLinks(container.querySelector("#available-links-list"), id, campaignLinks, container);
  });
}

function renderCampaignLinks(container, links, campaignId, rootContainer) {
  if (!links.length) {
    container.innerHTML = emptyState("link-slash", "No links in this campaign yet.");
    return;
  }

  container.innerHTML = renderTable({
    label: "Campaign links",
    columns: ["Short URL", "Destination", "Clicks", ""],
    rows: links.map(link => `
      <tr>
        <td>
          <div class="wa-cluster wa-gap-2xs">
            <a href="/links/${escapeAttr(link.id)}" data-link>${escapeHtml(link.slug)}</a>
            <wa-copy-button value="${escapeAttr(shortUrl(link))}" class="wa-font-size-s"></wa-copy-button>
          </div>
        </td>
        <td class="text-truncate wa-text-truncate">${escapeHtml(link.destinationUrl)}</td>
        <td>${link.totalClicks}</td>
        <td>
          <wa-button size="s" variant="danger" appearance="plain" pill class="remove-link-btn" data-link-id="${escapeAttr(link.id)}" aria-label="Remove from campaign">
            <wa-icon name="xmark"></wa-icon>
          </wa-button>
        </td>
      </tr>
    `),
  });

  // [data-link] anchors are handled by a global delegate in app.js.

  container.querySelectorAll(".remove-link-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const linkId = btn.dataset.linkId;
      await withLoadingBtn(btn, async () => {
        const res = await apiFetch(`/api/campaigns/${campaignId}/links/${linkId}`, { method: "DELETE" });
        if (!res) return;
        showToast("Link removed from campaign", "success");
        renderCampaignDetail(rootContainer, { id: campaignId });
      });
    });
  });
}

async function loadAvailableLinks(container, campaignId, existingLinks, rootContainer) {
  container.innerHTML = SPINNER;

  const result = await apiFetch("/api/links?limit=100");
  if (!result) {
    container.innerHTML = `<p class="wa-color-text-quiet">Failed to load links.</p>`;
    return;
  }
  const { data: allLinks } = result;
  const existingIds = new Set(existingLinks.map(l => l.id));
  const available = allLinks.filter(l => !existingIds.has(l.id));

  if (!available.length) {
    container.innerHTML = `<p class="wa-stack wa-align-items-center wa-color-text-quiet">All your links are already in this campaign.</p>`;
    return;
  }

  container.innerHTML = available.map(link => `
    <div class="wa-split">
      <div class="wa-stack wa-gap-2xs">
        <strong>${escapeHtml(link.slug)}</strong>
        <span class="text-truncate wa-text-truncate wa-body-s wa-color-text-quiet">${escapeHtml(link.destinationUrl)}</span>
      </div>
      <wa-button size="s" variant="brand" appearance="outlined" class="add-link-to-campaign-btn" data-link-id="${escapeAttr(link.id)}">Add</wa-button>
    </div>
  `).join("");

  container.querySelectorAll(".add-link-to-campaign-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const linkId = btn.dataset.linkId;
      await withLoadingBtn(btn, async () => {
        const res = await apiFetch(`/api/campaigns/${campaignId}/links`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkIds: [linkId] }),
        });
        if (!res) return;
        showToast("Link added to campaign", "success");
        rootContainer.querySelector("#add-links-dialog").open = false;
        renderCampaignDetail(rootContainer, { id: campaignId });
      });
    });
  });
}
