import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { SPINNER, apiFetch, withLoadingBtn, bindConfirmDialog, bindSearchInput, shortUrl, emptyState, errorCallout, statCard, renderTable, afterClose } from "../lib/ui.js";
import { fetchJSON } from "../lib/stats-common.js";
import { campaignFields, campaignBody } from "./campaigns.js";

export async function renderCampaignDetail(container, { id }) {
  // A refresh keeps the current markup until the new data lands, so adding or
  // removing a link neither flashes the spinner nor resets the scroll position.
  if (!container.childElementCount) container.innerHTML = SPINNER;

  // Aggregate stats cover a 30-day window, unlike the lifetime per-link totals
  // below. Best-effort: no toast on failure.
  const [campResult, recentClicks] = await Promise.all([
    apiFetch(`/api/campaigns/${id}`),
    fetchJSON(`/api/campaigns/${id}/stats`).then((r) => r.data?.totalClicks ?? 0, () => 0),
  ]);
  if (!campResult) {
    container.innerHTML = errorCallout("Failed to load campaign.");
    return;
  }
  const { data: campaign } = campResult;

  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <div class="wa-split">
        <div class="wa-cluster wa-gap-s wa-align-items-center">
          <wa-button variant="neutral" appearance="plain" pill href="/campaigns" data-link>
            <wa-icon name="arrow-left" label="Back to campaigns"></wa-icon>
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
        ${statCard("Links", `<wa-format-number value="${campaign.links.length}"></wa-format-number>`)}
        ${statCard("Clicks (30 days)", `<wa-format-number value="${recentClicks}"></wa-format-number>`)}
      </div>

      <div class="wa-split">
        <h2>Links</h2>
        <wa-button variant="brand" size="s" data-dialog="open add-links-dialog">
          <wa-icon slot="start" name="plus"></wa-icon>
          Add Links
        </wa-button>
      </div>
      <div id="campaign-links-list"></div>

      <wa-dialog id="add-links-dialog" label="Add Links to Campaign" light-dismiss style="--width:640px;">
        <div class="wa-stack wa-gap-m">
          <wa-input id="available-links-search" label="Search links" class="wa-visually-hidden-label" placeholder="Search links..." with-clear>
            <wa-icon slot="start" name="magnifying-glass"></wa-icon>
          </wa-input>
          <div id="available-links-list" class="wa-stack wa-gap-s"></div>
        </div>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Close</wa-button>
      </wa-dialog>

      <wa-dialog id="edit-campaign-dialog" label="Edit Campaign" light-dismiss>
        <form id="edit-campaign-form" class="wa-stack wa-gap-m">
          ${campaignFields(campaign)}
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

  renderCampaignLinks(container.querySelector("#campaign-links-list"), campaign.links, id, container);

  const editDialog = container.querySelector("#edit-campaign-dialog");
  const saveBtn = container.querySelector("#save-campaign-btn");
  container.querySelector("#edit-campaign-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoadingBtn(saveBtn, async () => {
      const res = await apiFetch(`/api/campaigns/${id}`, { method: "PUT", json: campaignBody(e.target) });
      if (!res) return;
      showToast("Campaign updated", "success");
      afterClose(editDialog, () => renderCampaignDetail(container, { id }));
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

  bindAddLinksDialog(container, id, campaign.links);
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
            <wa-copy-button value="${escapeAttr(shortUrl(link))}" copy-label="Copy short URL" class="wa-font-size-s"></wa-copy-button>
          </div>
        </td>
        <td class="text-truncate wa-text-truncate" title="${escapeAttr(link.destinationUrl)}">${escapeHtml(link.destinationUrl)}</td>
        <td><wa-format-number value="${link.totalClicks}"></wa-format-number></td>
        <td>
          <wa-button size="s" variant="danger" appearance="plain" pill class="remove-link-btn" data-link-id="${escapeAttr(link.id)}">
            <wa-icon name="xmark" label="Remove from campaign"></wa-icon>
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

/**
 * Wire the add-links dialog: it lists every link the user can reach that is not
 * yet in the campaign, searchable, and stays open across adds. The page behind
 * it refreshes once it closes, if anything was added.
 */
function bindAddLinksDialog(rootContainer, campaignId, campaignLinks) {
  const dialog = rootContainer.querySelector("#add-links-dialog");
  const searchInput = rootContainer.querySelector("#available-links-search");
  const list = rootContainer.querySelector("#available-links-list");
  const memberIds = new Set(campaignLinks.map((l) => l.id));
  const refresh = () => renderCampaignDetail(rootContainer, { id: campaignId });
  // `shown` holds from wa-show until wa-after-hide, so an add that lands while
  // the dialog animates closed still refreshes on after-hide, and one that lands
  // later refreshes at once.
  let shown = false;
  let added = false;
  let load = null;

  const emptyMessage = () => searchInput.value.trim()
    ? "No links match."
    : "All your links are already in this campaign.";

  /** List the candidate links matching `q`. A newer load aborts the last. */
  async function loadAvailableLinks(q = "") {
    load?.abort();
    const controller = new AbortController();
    load = controller;
    list.innerHTML = SPINNER;

    const params = new URLSearchParams({ limit: 100, scope: "all" });
    if (q.trim()) params.set("q", q.trim());
    const result = await apiFetch(`/api/links?${params}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (!result) {
      list.innerHTML = errorCallout("Failed to load links.");
      return;
    }

    const available = result.data.filter((l) => !memberIds.has(l.id));
    if (!available.length) {
      list.innerHTML = emptyState("link-slash", emptyMessage());
      return;
    }
    list.innerHTML = available.map(link => `
      <div class="wa-split available-link">
        <div class="wa-stack wa-gap-2xs">
          <strong>${escapeHtml(link.slug)}</strong>
          <span class="text-truncate wa-text-truncate wa-body-s wa-color-text-quiet" title="${escapeAttr(link.destinationUrl)}">${escapeHtml(link.destinationUrl)}</span>
        </div>
        <wa-button size="s" variant="brand" appearance="outlined" class="add-link-to-campaign-btn" data-link-id="${escapeAttr(link.id)}">Add</wa-button>
      </div>
    `).join("");
  }

  dialog.addEventListener("wa-show", (e) => {
    if (e.target !== dialog) return;
    shown = true;
    searchInput.value = "";
    loadAvailableLinks();
  });

  dialog.addEventListener("wa-after-hide", (e) => {
    if (e.target !== dialog) return;
    shown = false;
    if (!added) return;
    added = false;
    refresh();
  });

  bindSearchInput(searchInput, (q) => loadAvailableLinks(q));

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest(".add-link-to-campaign-btn");
    if (!btn) return;
    const linkId = btn.dataset.linkId;
    await withLoadingBtn(btn, async () => {
      const res = await apiFetch(`/api/campaigns/${campaignId}/links`, { method: "POST", json: { linkIds: [linkId] } });
      if (!res) return;
      memberIds.add(linkId);
      showToast("Link added to campaign", "success");
      if (!shown) {
        refresh();
        return;
      }
      added = true;
      // Focus moves to a neighbouring row's button, or the search field, so it
      // is not lost with the removed row.
      const row = btn.closest(".available-link");
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      if (next) {
        next.querySelector(".add-link-to-campaign-btn").focus();
      } else {
        list.innerHTML = emptyState("link-slash", emptyMessage());
        searchInput.focus();
      }
    });
  });
}
