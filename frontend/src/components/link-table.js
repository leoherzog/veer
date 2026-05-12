import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { shortUrl } from "../lib/ui.js";

const COLUMNS = [
  { key: "slug", label: "Short URL" },
  { key: "destinationUrl", label: "Destination" },
  { key: "title", label: "Title" },
  { key: "createdAt", label: "Created" },
];

function sortIndicator(col, sort) {
  if (sort.by !== col) return "";
  const icon = sort.dir === "asc" ? "angle-up" : "angle-down";
  return ` <wa-icon name="${icon}" class="wa-font-size-xs"></wa-icon>`;
}

export function renderLinkTable(container, { links, pagination, sort, onPageChange, onSort }) {
  if (!links.length) {
    container.innerHTML = `<div class="wa-stack wa-gap-m wa-align-items-center" style="padding:var(--wa-space-3xl);">
      <wa-icon name="link-slash" class="wa-font-size-2xl" style="opacity:0.5;"></wa-icon>
      <p>No links yet. Create your first short link above.</p>
    </div>`;
    return;
  }

  container.innerHTML = `
    <table class="link-table" aria-label="Your links">
      <thead>
        <tr>
          ${COLUMNS.map((col) => `<th data-sort="${col.key}">${col.label}${sortIndicator(col.key, sort)}</th>`).join("")}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${links.map((link) => `
          <tr>
            <td>
              <div class="wa-cluster wa-gap-2xs">
                <span>/${escapeHtml(link.slug)}</span>
                <wa-copy-button value="${escapeAttr(shortUrl(link))}" copy-label="Copy" success-label="Copied!" class="wa-font-size-s"><wa-icon slot="copy-icon" name="copy"></wa-icon><wa-icon slot="success-icon" name="check"></wa-icon></wa-copy-button>
                ${link.teamId && link.teamName ? `<wa-icon id="team-icon-${escapeAttr(link.id)}" name="people-group" class="wa-font-size-xs wa-color-text-quiet"></wa-icon><wa-tooltip for="team-icon-${escapeAttr(link.id)}">${escapeHtml(link.teamName)}</wa-tooltip>` : ""}
              </div>
            </td>
            <td class="text-truncate">${escapeHtml(link.destinationUrl)}</td>
            <td>${escapeHtml(link.title || "")}</td>
            <td>${new Date(link.createdAt).toLocaleDateString()}</td>
            <td>
              <div class="wa-cluster wa-gap-2xs">
                <wa-button size="small" variant="neutral" appearance="plain" pill data-edit="/links/${escapeAttr(link.id)}"><wa-icon name="pen-to-square" label="Edit"></wa-icon></wa-button>
                <wa-button size="small" variant="neutral" appearance="plain" pill data-href="${escapeAttr(shortUrl(link))}"><wa-icon name="arrow-up-right-from-square" label="Visit"></wa-icon></wa-button>
              </div>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ${pagination.total > pagination.limit ? `
      <div class="wa-cluster wa-gap-s wa-justify-content-center" style="margin-top:var(--wa-space-m);">
        <wa-button size="small" variant="neutral" ${pagination.page <= 1 ? "disabled" : ""} id="prev-page" aria-label="Previous page">Previous</wa-button>
        <span>Page ${pagination.page} of ${Math.ceil(pagination.total / pagination.limit)}</span>
        <wa-button size="small" variant="neutral" ${pagination.page * pagination.limit >= pagination.total ? "disabled" : ""} id="next-page" aria-label="Next page">Next</wa-button>
      </div>
    ` : ""}
  `;

  // Sort column click handlers
  container.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      const newDir = sort.by === col && sort.dir === "desc" ? "asc" : "desc";
      onSort(col, newDir);
    });
  });

  container.querySelectorAll("[data-edit]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.edit));
  });

  container.querySelector("#prev-page")?.addEventListener("click", () => onPageChange(pagination.page - 1));
  container.querySelector("#next-page")?.addEventListener("click", () => onPageChange(pagination.page + 1));

  container.querySelectorAll("[data-href]").forEach((el) => {
    el.addEventListener("click", () => window.open(el.dataset.href, "_blank", "noopener"));
  });
}
