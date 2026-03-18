import { renderLinkForm } from "../components/link-form.js";
import { renderQrCode } from "../components/qr-code.js";
import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { renderStatsCharts } from "../components/stats-charts.js";

function buildBadges(link) {
  const badges = [];

  if (link.expiresAt) {
    const expired = new Date(link.expiresAt) < new Date();
    if (expired) {
      badges.push(`<wa-badge variant="danger" pill>Expired</wa-badge>`);
    } else {
      badges.push(`<wa-badge variant="warning" pill>Expires ${new Date(link.expiresAt).toLocaleString()}</wa-badge>`);
    }
  }

  if (link.hasPassword) {
    badges.push(`<wa-badge variant="brand" pill>Password Protected</wa-badge>`);
  }

  if (link.isInternal) {
    badges.push(`<wa-badge variant="neutral" pill>Internal</wa-badge>`);
  }

  if (link.paramForwarding) {
    badges.push(`<wa-badge variant="neutral" pill>Param Forwarding</wa-badge>`);
  }

  if (link.campaignName) {
    badges.push(`<wa-badge variant="brand" pill>${escapeHtml(link.campaignName)}</wa-badge>`);
  }

  return badges.join(" ");
}

function buildOgPreview(link) {
  if (!link.ogTitle && !link.ogDescription && !link.ogImage) return "";
  const safeOgImage = link.ogImage && /^https?:\/\//.test(link.ogImage) ? link.ogImage : null;
  return `
    <wa-card>
      <div class="wa-stack wa-gap-s">
        <h3>Social Preview</h3>
        <div style="border:1px solid var(--wa-color-border-default);border-radius:var(--wa-border-radius-medium);overflow:hidden;">
          ${safeOgImage ? `<img src="${escapeAttr(safeOgImage)}" alt="OG preview" style="width:100%;max-height:200px;object-fit:cover;">` : ""}
          <div style="padding:0.75rem;">
            ${link.ogTitle ? `<div style="font-weight:600;">${escapeHtml(link.ogTitle)}</div>` : ""}
            ${link.ogDescription ? `<div style="color:var(--wa-color-text-subdued);font-size:0.875rem;margin-top:0.25rem;">${escapeHtml(link.ogDescription)}</div>` : ""}
          </div>
        </div>
      </div>
    </wa-card>
  `;
}

function buildTargetingRules(targets) {
  if (!targets || !targets.length) return "";
  return `
    <wa-card>
      <div class="wa-stack wa-gap-s">
        <h3>Targeting Rules</h3>
        <table class="link-table" aria-label="Targeting rules">
          <thead>
            <tr>
              <th>Type</th>
              <th>Match</th>
              <th>Destination</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            ${targets.map(t => `
              <tr>
                <td><wa-badge variant="${t.type === "geo" ? "neutral" : "brand"}" pill>${escapeHtml(t.type === "geo" ? "Country" : "Device")}</wa-badge></td>
                <td>${escapeHtml(t.matchValue)}</td>
                <td class="truncate">${escapeHtml(t.destinationUrl)}</td>
                <td>${t.priority}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </wa-card>
  `;
}

export async function renderLinkDetail(container, { id }) {
  container.innerHTML = `<div style="text-align:center;padding:3rem;"><wa-spinner></wa-spinner></div>`;

  let link;
  let targets = [];
  try {
    const [linkRes, targetsRes] = await Promise.all([
      fetch(`/api/links/${id}`),
      fetch(`/api/links/${id}/targets`).catch(() => null),
    ]);
    if (linkRes.status === 401) { window.location.href = "/login"; return; }
    if (!linkRes.ok) {
      container.innerHTML = `<div style="text-align:center;padding:3rem;"><p>Link not found.</p></div>`;
      return;
    }
    ({ data: link } = await linkRes.json());
    if (targetsRes && targetsRes.ok) {
      ({ data: targets } = await targetsRes.json());
    }
  } catch {
    showToast("Failed to load link details", "danger");
    container.innerHTML = `<div style="text-align:center;padding:3rem;"><p>Failed to load link. Please try again.</p></div>`;
    return;
  }

  // Attach targets to link for edit form
  link.targets = targets;

  const shortUrl = `${location.origin}/${link.slug}`;
  const safeDestUrl = /^https?:\/\//.test(link.destinationUrl) ? link.destinationUrl : null;
  const badges = buildBadges(link);
  const maxClicksInfo = link.maxClicks != null
    ? `<div><strong>Click Limit:</strong> ${link.totalClicks} / ${link.maxClicks}</div>`
    : "";

  container.innerHTML = `
    <div class="link-detail-view wa-stack wa-gap-l" style="max-width:900px;margin:2rem auto;">
      <div class="wa-split">
        <h1>/${escapeHtml(link.slug)}</h1>
        <div class="wa-cluster wa-gap-xs">
          <wa-button variant="brand" id="edit-link-btn">
            <wa-icon slot="start" name="pen-to-square"></wa-icon>
            Edit
          </wa-button>
          <wa-button variant="danger" appearance="outlined" id="delete-btn">
            <wa-icon slot="start" name="trash"></wa-icon>
            Delete
          </wa-button>
        </div>
      </div>

      <wa-card>
        <div class="wa-flank:end wa-gap-l wa-align-items-start">
          <div class="wa-stack wa-gap-s">
            <div class="wa-cluster wa-gap-2xs">
              <strong>Short URL:</strong>
              <a href="${escapeAttr(shortUrl)}" target="_blank" rel="noopener">${escapeHtml(shortUrl)}</a>
              <wa-copy-button value="${escapeAttr(shortUrl)}"></wa-copy-button>
            </div>
            <div><strong>Destination:</strong> ${safeDestUrl ? `<a href="${escapeAttr(safeDestUrl)}" target="_blank" rel="noopener">${escapeHtml(link.destinationUrl)}</a>` : escapeHtml(link.destinationUrl)}</div>
            <div><strong>Lifetime Clicks:</strong> ${link.totalClicks}</div>
            ${maxClicksInfo}
            <div><strong>Created:</strong> ${new Date(link.createdAt).toLocaleString()}</div>
            ${link.paramForwarding ? `<div><strong>Query Params:</strong> Forwarded to destination</div>` : ""}
            ${badges ? `<div class="wa-cluster wa-gap-2xs" style="margin-top:0.25rem;">${badges}</div>` : ""}
          </div>
          <div id="qr-container"></div>
        </div>
      </wa-card>

      ${buildTargetingRules(targets)}
      ${buildOgPreview(link)}

      <div id="edit-section" style="display:none;">
        <wa-card>
          <div id="edit-form"></div>
        </wa-card>
      </div>

      ${link.totalClicks > 0 ? '<div id="stats-container"></div>' : ''}
    </div>
  `;

  renderQrCode(container.querySelector("#qr-container"), shortUrl);

  const editSection = container.querySelector("#edit-section");
  const editBtn = container.querySelector("#edit-link-btn");
  editBtn.addEventListener("click", () => {
    const visible = editSection.style.display !== "none";
    editSection.style.display = visible ? "none" : "block";
    if (!visible) {
      renderLinkForm(container.querySelector("#edit-form"), {
        link,
        onSuccess: () => renderLinkDetail(container, { id }),
      });
    }
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
      navigate("/links");
    } catch {
      showToast("Network error — could not delete link", "danger");
    }
  });

  // Render analytics charts (only if link has clicks)
  const statsEl = container.querySelector("#stats-container");
  if (statsEl) renderStatsCharts(statsEl, link.id);
}
