import { renderLinkForm } from "../components/link-form.js";
import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { renderStatsCharts } from "../components/stats-charts.js";

export async function renderLinkDetail(container, { id }) {
  container.innerHTML = `<div style="text-align:center;padding:3rem;"><wa-spinner></wa-spinner></div>`;

  let link;
  try {
    const res = await fetch(`/api/links/${id}`);
    if (res.status === 401) { window.location.href = "/login"; return; }
    if (!res.ok) {
      container.innerHTML = `<div style="text-align:center;padding:3rem;"><p>Link not found.</p></div>`;
      return;
    }
    ({ data: link } = await res.json());
  } catch {
    showToast("Failed to load link details", "danger");
    container.innerHTML = `<div style="text-align:center;padding:3rem;"><p>Failed to load link. Please try again.</p></div>`;
    return;
  }
  const shortUrl = `${location.origin}/${link.slug}`;
  const safeDestUrl = /^https?:\/\//.test(link.destinationUrl) ? link.destinationUrl : null;

  container.innerHTML = `
    <div class="link-detail-view wa-stack wa-gap-l" style="max-width:900px;margin:2rem auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h1>${escapeHtml(link.title || link.slug)}</h1>
        <wa-button variant="danger" appearance="outlined" id="delete-btn">
          <wa-icon slot="prefix" name="trash"></wa-icon>
          Delete
        </wa-button>
      </div>

      <wa-card>
        <div class="wa-stack wa-gap-s">
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <strong>Short URL:</strong>
            <a href="${escapeAttr(shortUrl)}" target="_blank" rel="noopener">${escapeHtml(shortUrl)}</a>
            <wa-copy-button value="${escapeAttr(shortUrl)}"></wa-copy-button>
          </div>
          <div><strong>Destination:</strong> ${safeDestUrl ? `<a href="${escapeAttr(safeDestUrl)}" target="_blank" rel="noopener">${escapeHtml(link.destinationUrl)}</a>` : escapeHtml(link.destinationUrl)}</div>
          <div><strong>Redirect:</strong> ${link.redirectType}</div>
          <div><strong>Total Clicks:</strong> ${link.totalClicks}</div>
          <div><strong>Created:</strong> ${new Date(link.createdAt).toLocaleString()}</div>
        </div>
      </wa-card>

      <wa-details summary="Edit Link">
        <div id="edit-form"></div>
      </wa-details>

      <div id="stats-container"></div>
    </div>
  `;

  renderLinkForm(container.querySelector("#edit-form"), {
    link,
    onSuccess: () => renderLinkDetail(container, { id }),
  });

  container.querySelector("#delete-btn").addEventListener("click", async () => {
    if (!confirm("Delete this link? This cannot be undone.")) return;
    try {
      const delRes = await fetch(`/api/links/${id}`, { method: "DELETE" });
      if (!delRes.ok) {
        showToast("Failed to delete link", "danger");
        return;
      }
      showToast("Link deleted", "success");
      navigate("/dashboard");
    } catch {
      showToast("Network error — could not delete link", "danger");
    }
  });

  // Render analytics charts
  renderStatsCharts(container.querySelector("#stats-container"), link.id);
}
