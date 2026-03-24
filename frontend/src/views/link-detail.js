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

  if (link.campaigns?.length) {
    for (const c of link.campaigns) {
      badges.push(`<wa-badge variant="brand" pill>${escapeHtml(c.name)}</wa-badge>`);
    }
  } else if (link.campaignName) {
    badges.push(`<wa-badge variant="brand" pill>${escapeHtml(link.campaignName)}</wa-badge>`);
  }

  if (link.domainHostname) {
    badges.push(`<wa-badge variant="neutral" pill>Custom Domain: ${escapeHtml(link.domainHostname)}</wa-badge>`);
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
        <div class="og-preview">
          ${safeOgImage ? `<img src="${escapeAttr(safeOgImage)}" alt="OG preview">` : ""}
          <div class="og-preview-body">
            ${link.ogTitle ? `<div style="font-weight:var(--wa-font-weight-bold);">${escapeHtml(link.ogTitle)}</div>` : ""}
            ${link.ogDescription ? `<div class="wa-body-s text-quiet" style="margin-top:var(--wa-space-3xs);">${escapeHtml(link.ogDescription)}</div>` : ""}
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
  container.innerHTML = `<div class="text-center" style="padding:var(--wa-space-3xl);"><wa-spinner></wa-spinner></div>`;

  let link;
  let targets = [];
  try {
    const [linkRes, targetsRes] = await Promise.all([
      fetch(`/api/links/${id}`),
      fetch(`/api/links/${id}/targets`).catch(() => null),
    ]);
    if (linkRes.status === 401) { window.location.href = "/login"; return; }
    if (!linkRes.ok) {
      container.innerHTML = `<div class="text-center" style="padding:var(--wa-space-3xl);"><p>Link not found.</p></div>`;
      return;
    }
    ({ data: link } = await linkRes.json());
    if (targetsRes && targetsRes.ok) {
      ({ data: targets } = await targetsRes.json());
    }
  } catch {
    showToast("Failed to load link details", "danger");
    container.innerHTML = `<div class="text-center" style="padding:var(--wa-space-3xl);"><p>Failed to load link. Please try again.</p></div>`;
    return;
  }

  // Attach targets to link for edit form
  link.targets = targets;

  // Use domainHostname from API response (returned by GET /api/links/:id)
  const domainHostname = link.domainHostname;
  const shortUrl = domainHostname
    ? `https://${domainHostname}/${link.slug}`
    : `${location.origin}/${link.slug}`;
  const safeDestUrl = /^https?:\/\//.test(link.destinationUrl) ? link.destinationUrl : null;
  const badges = buildBadges(link);
  const maxClicksInfo = link.maxClicks != null
    ? `<div><strong>Click Limit:</strong> ${link.totalClicks} / ${link.maxClicks}</div>`
    : "";

  container.innerHTML = `
    <div class="link-detail-view wa-stack wa-gap-l">
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
            ${badges ? `<div class="wa-cluster wa-gap-2xs" style="margin-top:var(--wa-space-3xs);">${badges}</div>` : ""}
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
