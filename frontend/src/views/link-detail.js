import { renderLinkForm } from "../components/link-form.js";
import { renderQrCode } from "../components/qr-code.js";
import { showToast } from "../components/toast.js";
import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { renderStatsCharts } from "../components/stats-charts.js";
import { SPINNER, apiFetch, withLoadingBtn, shortUrl } from "../lib/ui.js";

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
            ${link.ogTitle ? `<div class="wa-font-weight-bold">${escapeHtml(link.ogTitle)}</div>` : ""}
            ${link.ogDescription ? `<div class="wa-body-s wa-color-text-quiet" style="margin-top:var(--wa-space-3xs);">${escapeHtml(link.ogDescription)}</div>` : ""}
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
                <td class="text-truncate">${escapeHtml(t.destinationUrl)}</td>
                <td>${t.priority}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </wa-card>
  `;
}

function buildPublicReportCard(report) {
  if (!report) return "";
  const reportUrl = `${location.origin}/r/${report.token}`;
  return `
    <wa-card>
      <div class="wa-stack wa-gap-s">
        <div class="wa-split">
          <h3>Public Report</h3>
          <wa-switch id="report-toggle" ${report.isEnabled ? "checked" : ""}></wa-switch>
        </div>
        <p class="wa-body-s wa-color-text-quiet">Share your analytics dashboard with others via a public link.</p>
        <div id="report-link-container" class="wa-cluster wa-gap-2xs" style="display: ${report.isEnabled ? "flex" : "none"};">
          <wa-input readonly value="${escapeAttr(reportUrl)}" style="flex:1;"></wa-input>
          <wa-copy-button value="${escapeAttr(reportUrl)}"></wa-copy-button>
          <wa-button variant="neutral" appearance="outlined" data-href="${escapeAttr(reportUrl)}">
            <wa-icon name="arrow-up-right-from-square"></wa-icon>
          </wa-button>
        </div>
      </div>
    </wa-card>
  `;
}

export async function renderLinkDetail(container, { id }) {
  container.innerHTML = SPINNER;

  const linkResult = await apiFetch(`/api/links/${id}`);
  if (!linkResult) return;
  const { data: link } = linkResult;

  let targets = [];
  let report = null;
  const [targetsResult, reportResult] = await Promise.all([
    apiFetch(`/api/links/${id}/targets`).catch(() => null),
    apiFetch(`/api/reports/${id}`, { method: "POST" }).catch(() => null),
  ]);
  if (targetsResult?.data) targets = targetsResult.data;
  if (reportResult?.data) report = reportResult.data;

  // Attach targets to link for edit form
  link.targets = targets;

  // Use domainHostname from API response (returned by GET /api/links/:id)
  const linkShortUrl = shortUrl(link);
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
        <div class="wa-flank wa-gap-l wa-align-items-start">
          <div class="wa-stack wa-gap-s">
            <div class="wa-cluster wa-gap-2xs">
              <strong>Short URL:</strong>
              <a href="${escapeAttr(linkShortUrl)}" target="_blank" rel="noopener">${escapeHtml(linkShortUrl)}</a>
              <wa-copy-button value="${escapeAttr(linkShortUrl)}"></wa-copy-button>
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

      ${buildPublicReportCard(report)}
      ${buildTargetingRules(targets)}
      ${buildOgPreview(link)}

      <div id="edit-section" style="display:none;">
        <wa-card>
          <div id="edit-form"></div>
        </wa-card>
      </div>

      ${link.totalClicks > 0 ? '<div id="stats-container"></div>' : ''}

      <wa-dialog id="delete-link-dialog" label="Delete Link">
        <p>Are you sure you want to delete <strong>/${escapeHtml(link.slug)}</strong>? This cannot be undone.</p>
        <wa-button slot="footer" id="delete-link-cancel-btn" variant="neutral" appearance="outlined">Cancel</wa-button>
        <wa-button slot="footer" id="delete-link-confirm-btn" variant="danger">Delete</wa-button>
      </wa-dialog>
    </div>
  `;

  renderQrCode(container.querySelector("#qr-container"), linkShortUrl);

  const reportToggle = container.querySelector("#report-toggle");
  if (reportToggle) {
    reportToggle.addEventListener("change", async (e) => {
      const isEnabled = e.target.checked;
      const result = await apiFetch(`/api/reports/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled }),
      });
      if (!result) {
        e.target.checked = !isEnabled;
        return;
      }
      const containerDiv = container.querySelector("#report-link-container");
      if (containerDiv) {
        containerDiv.style.display = isEnabled ? "flex" : "none";
      }
    });
  }

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

  const deleteLinkDialog = container.querySelector("#delete-link-dialog");

  container.querySelector("#delete-btn").addEventListener("click", () => {
    deleteLinkDialog.open = true;
  });

  container.querySelector("#delete-link-cancel-btn").addEventListener("click", () => {
    deleteLinkDialog.open = false;
  });

  container.querySelector("#delete-link-confirm-btn").addEventListener("click", async (e) => {
    const confirmBtn = e.currentTarget;
    await withLoadingBtn(confirmBtn, async () => {
      const delRes = await apiFetch(`/api/links/${id}`, { method: "DELETE" });
      if (!delRes) return;
      deleteLinkDialog.open = false;
      showToast("Link deleted", "success");
      navigate("/links");
    });
  });

  // Render analytics charts (only if link has clicks)
  const statsEl = container.querySelector("#stats-container");
  if (statsEl) renderStatsCharts(statsEl, link.id);
}
