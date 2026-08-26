import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { shortUrl, emptyState, renderPagination, renderTable } from "../lib/ui.js";

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
    container.innerHTML = emptyState("link-slash", "No links yet. Create your first short link above.");
    return;
  }

  container.innerHTML = renderTable({
    label: "Your links",
    columns: [
      ...COLUMNS.map((col) => ({ label: col.label, sortKey: col.key, html: sortIndicator(col.key, sort) })),
      "",
    ],
    rows: links.map((link) => `
      <tr>
        <td>
          <div class="wa-cluster wa-gap-2xs">
            <span>/${escapeHtml(link.slug)}</span>
            <wa-copy-button value="${escapeAttr(shortUrl(link))}" copy-label="Copy" success-label="Copied!" class="wa-font-size-s"></wa-copy-button>
            ${link.teamId && link.teamName ? `<wa-icon id="team-icon-${escapeAttr(link.id)}" name="people-group" label="Team" class="wa-font-size-xs wa-color-text-quiet"></wa-icon><wa-tooltip for="team-icon-${escapeAttr(link.id)}">${escapeHtml(link.teamName)}</wa-tooltip>` : ""}
          </div>
        </td>
        <td class="text-truncate wa-text-truncate">${escapeHtml(link.destinationUrl)}</td>
        <td>${escapeHtml(link.title || "")}</td>
        <td><wa-relative-time date="${escapeAttr(link.createdAt)}"></wa-relative-time></td>
        <td>
          <div class="wa-cluster wa-gap-2xs">
            <wa-button size="s" variant="neutral" appearance="plain" pill href="/links/${escapeAttr(link.id)}" data-link><wa-icon name="pen-to-square" label="Edit"></wa-icon></wa-button>
            <wa-button size="s" variant="neutral" appearance="plain" pill href="${escapeAttr(shortUrl(link))}" target="_blank" rel="noopener"><wa-icon name="arrow-up-right-from-square" label="Visit"></wa-icon></wa-button>
          </div>
        </td>
      </tr>
    `),
  });

  renderPagination(container, {
    page: pagination.page,
    total: pagination.total,
    limit: pagination.limit,
    onPageChange,
  });

  // Sort column click handlers
  container.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      const newDir = sort.by === col && sort.dir === "desc" ? "asc" : "desc";
      onSort(col, newDir);
    });
  });
}
