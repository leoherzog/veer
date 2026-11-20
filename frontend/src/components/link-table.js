import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { shortUrl, emptyState, renderPagination, renderTable, relativeTime } from "../lib/ui.js";

const COLUMNS = [
  { key: "slug", label: "Short URL" },
  { key: "destinationUrl", label: "Destination" },
  { key: "title", label: "Title" },
  { key: "createdAt", label: "Created" },
];

/** Direction arrow for the active sort column. Decorative: `aria-sort` on the header carries the state. */
function sortIndicator(col, sort) {
  if (sort.by !== col) return "";
  const icon = sort.dir === "asc" ? "angle-up" : "angle-down";
  return ` <wa-icon name="${icon}" class="wa-font-size-xs"></wa-icon>`;
}

function renderRow(link) {
  const url = shortUrl(link);
  return `
      <tr>
        <td>
          <div class="wa-cluster wa-gap-2xs">
            <span>/${escapeHtml(link.slug)}</span>
            <wa-copy-button value="${escapeAttr(url)}" copy-label="Copy short URL" class="wa-font-size-s"></wa-copy-button>
            ${link.teamId && link.teamName ? `<wa-icon id="team-icon-${escapeAttr(link.id)}" name="people-group" label="Team" class="wa-font-size-xs wa-color-text-quiet"></wa-icon><wa-tooltip for="team-icon-${escapeAttr(link.id)}">${escapeHtml(link.teamName)}</wa-tooltip>` : ""}
          </div>
        </td>
        <td class="text-truncate wa-text-truncate" title="${escapeAttr(link.destinationUrl)}">${escapeHtml(link.destinationUrl)}</td>
        <td>${escapeHtml(link.title)}</td>
        <td>${relativeTime(link.createdAt)}</td>
        <td>
          <div class="wa-cluster wa-gap-2xs">
            <wa-button size="s" variant="neutral" appearance="plain" pill href="/links/${escapeAttr(link.id)}" data-link><wa-icon name="pen-to-square" label="Edit"></wa-icon></wa-button>
            <wa-button size="s" variant="neutral" appearance="plain" pill href="${escapeAttr(url)}" target="_blank" rel="noopener"><wa-icon name="arrow-up-right-from-square" label="Visit"></wa-icon></wa-button>
          </div>
        </td>
      </tr>
    `;
}

/**
 * Render the dashboard's link table with server-side sort headers. `empty` is
 * the message for no rows. `focusSort` returns focus to the active sort header,
 * which this render replaces, unless focus has already moved elsewhere.
 */
export function renderLinkTable(container, { links, pagination, sort, onPageChange, onSort, empty, focusSort = false }) {
  if (!links.length) {
    container.innerHTML = emptyState("link-slash", empty);
    return;
  }

  const restoreFocus = focusSort && (container.contains(document.activeElement) || document.activeElement === document.body);

  container.innerHTML = renderTable({
    label: "Your links",
    columns: [
      // A button inside the header keeps the cell's columnheader role, which
      // `aria-sort` belongs on.
      ...COLUMNS.map((col) => ({
        sortKey: col.key,
        html: `<button type="button" class="th-sort">${col.label}${sortIndicator(col.key, sort)}</button>`,
      })),
      "",
    ],
    rows: links.map(renderRow),
  });

  renderPagination(container, {
    page: pagination.page,
    total: pagination.total,
    limit: pagination.limit,
    onPageChange,
  });

  const active = container.querySelector(`th[data-sort="${sort.by}"]`);
  active?.setAttribute("aria-sort", sort.dir === "asc" ? "ascending" : "descending");
  if (restoreFocus) active?.querySelector(".th-sort").focus();

  container.querySelector("thead").addEventListener("click", (e) => {
    const col = e.target.closest(".th-sort")?.closest("th").dataset.sort;
    if (!col) return;
    onSort(col, sort.by === col && sort.dir === "desc" ? "asc" : "desc");
  });
}
