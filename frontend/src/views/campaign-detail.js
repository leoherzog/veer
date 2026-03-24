import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";

export async function renderCampaignDetail(container, { id }) {
  container.innerHTML = `<div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-3xl);"><wa-spinner></wa-spinner></div>`;

  let campaign;
  let campaignLinks;
  let totalClicks = 0;
  try {
    const campRes = await fetch(`/api/campaigns/${id}`);
    if (campRes.status === 401) { window.location.href = "/login"; return; }
    if (!campRes.ok) {
      container.innerHTML = `<div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-3xl);"><p>Campaign not found.</p></div>`;
      return;
    }
    ({ data: campaign } = await campRes.json());
    campaignLinks = campaign.links || [];

    // Fetch aggregate stats from dedicated endpoint
    try {
      const statsRes = await fetch(`/api/campaigns/${id}/stats`);
      if (statsRes.ok) {
        const { data: stats } = await statsRes.json();
        totalClicks = stats.totalClicks || 0;
      }
    } catch { /* stats are best-effort */ }
  } catch {
    showToast("Failed to load campaign details", "danger");
    container.innerHTML = `<div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-3xl);"><p>Failed to load campaign. Please try again.</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="campaign-detail-view wa-stack wa-gap-l">
      <div class="wa-split">
        <div class="wa-cluster wa-gap-s wa-align-items-center">
          <wa-button variant="neutral" appearance="plain" circle id="back-btn" aria-label="Back to campaigns">
            <wa-icon name="arrow-left"></wa-icon>
          </wa-button>
          <h1 id="campaign-name">${escapeHtml(campaign.name)}</h1>
        </div>
        <div class="wa-cluster wa-gap-xs">
          <wa-button variant="neutral" id="edit-campaign-btn">
            <wa-icon slot="start" name="pen-to-square"></wa-icon>
            Edit
          </wa-button>
          <wa-button variant="danger" appearance="outlined" id="delete-campaign-btn">
            <wa-icon slot="start" name="trash"></wa-icon>
            Delete
          </wa-button>
        </div>
      </div>

      ${campaign.description ? `<p class="wa-color-text-quiet">${escapeHtml(campaign.description)}</p>` : ""}

      <div id="edit-section" style="display:none;">
        <wa-card>
          <form id="edit-campaign-form" class="wa-stack wa-gap-m">
            <wa-input name="name" label="Campaign Name" required value="${escapeAttr(campaign.name)}"></wa-input>
            <wa-textarea name="description" label="Description (optional)" rows="2" value="${escapeAttr(campaign.description || "")}"></wa-textarea>
            <div class="wa-cluster wa-gap-s">
              <wa-button type="submit" variant="brand">Save Changes</wa-button>
              <wa-button variant="neutral" id="cancel-edit-btn">Cancel</wa-button>
            </div>
          </form>
        </wa-card>
      </div>

      <div class="wa-split wa-gap-m">
        <wa-card>
          <div class="wa-stack wa-gap-2xs wa-align-items-center">
            <span class="wa-heading-xl">${campaignLinks.length}</span>
            <span class="wa-caption-s wa-color-text-quiet">Links</span>
          </div>
        </wa-card>
        <wa-card>
          <div class="wa-stack wa-gap-2xs wa-align-items-center">
            <span class="wa-heading-xl">${totalClicks}</span>
            <span class="wa-caption-s wa-color-text-quiet">Total Clicks</span>
          </div>
        </wa-card>
      </div>

      <div class="wa-split">
        <h2>Links</h2>
        <wa-button variant="brand" size="small" id="add-links-btn">
          <wa-icon slot="start" name="plus"></wa-icon>
          Add Links
        </wa-button>
      </div>
      <div id="campaign-links-list"></div>

      <wa-dialog id="add-links-dialog" label="Add Links to Campaign" style="--width:600px;">
        <div id="available-links-list" class="wa-stack wa-gap-s">
          <div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-m);"><wa-spinner></wa-spinner></div>
        </div>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Close</wa-button>
      </wa-dialog>
    </div>
  `;

  renderCampaignLinks(container.querySelector("#campaign-links-list"), campaignLinks, id, container);

  // Back button
  container.querySelector("#back-btn").addEventListener("click", () => navigate("/campaigns"));

  // Edit toggle
  const editSection = container.querySelector("#edit-section");
  container.querySelector("#edit-campaign-btn").addEventListener("click", () => {
    editSection.style.display = editSection.style.display === "none" ? "block" : "none";
  });
  container.querySelector("#cancel-edit-btn").addEventListener("click", () => {
    editSection.style.display = "none";
  });

  // Edit submit
  container.querySelector("#edit-campaign-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('wa-button[type="submit"]');
    btn.loading = true;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/campaigns/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: e.target.querySelector('[name="name"]').value.trim(),
          description: e.target.querySelector('[name="description"]').value.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || "Failed to update campaign", "danger");
        return;
      }
      showToast("Campaign updated", "success");
      renderCampaignDetail(container, { id });
    } catch {
      showToast("Network error", "danger");
    } finally {
      btn.loading = false;
      btn.disabled = false;
    }
  });

  // Delete campaign
  container.querySelector("#delete-campaign-btn").addEventListener("click", async () => {
    if (!confirm("Delete this campaign? Links will not be deleted, only unlinked from the campaign.")) return;
    try {
      const res = await fetch(`/api/campaigns/${id}`, { method: "DELETE" });
      if (!res.ok) {
        showToast("Failed to delete campaign", "danger");
        return;
      }
      showToast("Campaign deleted", "success");
      navigate("/campaigns");
    } catch {
      showToast("Network error", "danger");
    }
  });

  // Add links dialog
  const dialog = container.querySelector("#add-links-dialog");
  container.querySelector("#add-links-btn").addEventListener("click", async () => {
    dialog.open = true;
    await loadAvailableLinks(container.querySelector("#available-links-list"), id, campaignLinks, container);
  });
}

function renderCampaignLinks(container, links, campaignId, rootContainer) {
  if (!links.length) {
    container.innerHTML = `
      <div class="wa-stack wa-gap-m wa-align-items-center" style="padding:var(--wa-space-2xl);">
        <wa-icon name="link-slash" class="wa-font-size-2xl" style="opacity:0.5;"></wa-icon>
        <p class="wa-color-text-quiet">No links in this campaign yet.</p>
      </div>
    `;
    return;
  }

  const shortUrl = (link) => link.domainHostname ? `https://${link.domainHostname}/${link.slug}` : `${location.origin}/${link.slug}`;
  container.innerHTML = `
    <table class="link-table" aria-label="Campaign links">
      <thead>
        <tr>
          <th>Short URL</th>
          <th>Destination</th>
          <th>Clicks</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${links.map(link => `
          <tr>
            <td>
              <div class="wa-cluster wa-gap-2xs">
                <a href="/links/${escapeAttr(link.id)}" data-link>${escapeHtml(link.slug)}</a>
                <wa-copy-button value="${escapeAttr(shortUrl(link))}" copy-label="Copy" success-label="Copied!" class="wa-font-size-s"></wa-copy-button>
              </div>
            </td>
            <td class="text-truncate">${escapeHtml(link.destinationUrl)}</td>
            <td>${link.totalClicks || 0}</td>
            <td>
              <wa-button size="small" variant="danger" appearance="plain" circle class="remove-link-btn" data-link-id="${escapeAttr(link.id)}" aria-label="Remove from campaign">
                <wa-icon name="xmark"></wa-icon>
              </wa-button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  container.querySelectorAll("[data-link]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(el.getAttribute("href"));
    });
  });

  container.querySelectorAll(".remove-link-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const linkId = btn.dataset.linkId;
      btn.loading = true;
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/links/${linkId}`, { method: "DELETE" });
        if (!res.ok) {
          showToast("Failed to remove link", "danger");
          return;
        }
        showToast("Link removed from campaign", "success");
        const idx = links.findIndex(l => l.id === linkId);
        if (idx !== -1) links.splice(idx, 1);
        renderCampaignLinks(container, links, campaignId, rootContainer);
        // Update link count display
        const countEl = rootContainer.querySelector(".wa-heading-xl");
        if (countEl) countEl.textContent = links.length;
      } catch {
        showToast("Network error", "danger");
      }
    });
  });
}

async function loadAvailableLinks(container, campaignId, existingLinks, rootContainer) {
  container.innerHTML = `<div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-m);"><wa-spinner></wa-spinner></div>`;
  try {
    const res = await fetch("/api/links?limit=100");
    if (!res.ok) {
      container.innerHTML = `<p class="wa-color-text-quiet">Failed to load links.</p>`;
      return;
    }
    const { data: allLinks } = await res.json();
    const existingIds = new Set(existingLinks.map(l => l.id));
    const available = allLinks.filter(l => !existingIds.has(l.id));

    if (!available.length) {
      container.innerHTML = `<p class="wa-stack wa-align-items-center wa-color-text-quiet" style="padding:var(--wa-space-m);">All your links are already in this campaign.</p>`;
      return;
    }

    container.innerHTML = `
      <div class="wa-stack wa-gap-s">
        ${available.map(link => `
          <div class="wa-split available-link-row">
            <div class="wa-stack wa-gap-2xs">
              <strong>${escapeHtml(link.slug)}</strong>
              <span class="text-truncate wa-body-s wa-color-text-quiet">${escapeHtml(link.destinationUrl)}</span>
            </div>
            <wa-button size="small" variant="brand" appearance="outlined" class="add-link-to-campaign-btn" data-link-id="${escapeAttr(link.id)}">Add</wa-button>
          </div>
        `).join("")}
      </div>
    `;

    container.querySelectorAll(".add-link-to-campaign-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const linkId = btn.dataset.linkId;
        btn.loading = true;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/campaigns/${campaignId}/links`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ linkIds: [linkId] }),
          });
          if (!res.ok) {
            const err = await res.json();
            showToast(err.error || "Failed to add link", "danger");
            return;
          }
          showToast("Link added to campaign", "success");
          btn.closest(".available-link-row").remove();
          // Mutate local state and re-render links section
          const addedLink = available.find(l => l.id === linkId);
          if (addedLink) existingLinks.push(addedLink);
          const linksContainer = rootContainer.querySelector("#campaign-links-list");
          if (linksContainer) renderCampaignLinks(linksContainer, existingLinks, campaignId, rootContainer);
          const countEl = rootContainer.querySelector(".wa-heading-xl");
          if (countEl) countEl.textContent = existingLinks.length;
          // Close dialog
          const dlg = rootContainer.querySelector("#add-links-dialog");
          if (dlg) dlg.open = false;
        } catch {
          showToast("Network error", "danger");
        } finally {
          btn.loading = false;
          btn.disabled = false;
        }
      });
    });
  } catch {
    container.innerHTML = `<p class="wa-color-text-quiet">Failed to load links.</p>`;
  }
}
