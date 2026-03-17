import { navigate } from "../router.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";

export function renderLinkTable(container, { links, pagination, onPageChange }) {
  if (!links.length) {
    container.innerHTML = `<div class="wa-stack wa-gap-m" style="text-align:center; padding: 3rem;">
      <wa-icon name="link-slash" style="font-size: 2rem; opacity: 0.5;"></wa-icon>
      <p>No links yet. Create your first short link above.</p>
    </div>`;
    return;
  }

  const baseUrl = location.origin;
  container.innerHTML = `
    <table class="link-table" aria-label="Your links">
      <thead>
        <tr>
          <th>Short URL</th>
          <th>Destination</th>
          <th>Title</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${links.map((link) => `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:0.5rem;">
                <a href="/links/${escapeAttr(link.id)}" data-link>${escapeHtml(link.slug)}</a>
                <wa-copy-button value="${escapeAttr(baseUrl + "/" + link.slug)}" copy-label="Copy" success-label="Copied!" style="--font-size: 0.875rem;"></wa-copy-button>
              </div>
            </td>
            <td class="truncate">${escapeHtml(link.destinationUrl)}</td>
            <td>${escapeHtml(link.title || "")}</td>
            <td>${new Date(link.createdAt).toLocaleDateString()}</td>
            <td>
              <wa-button size="small" variant="neutral" appearance="plain" circle data-href="${escapeAttr(baseUrl + "/" + link.slug)}"><wa-icon name="arrow-up-right-from-square" label="Visit"></wa-icon></wa-button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ${pagination.total > pagination.limit ? `
      <div class="wa-cluster wa-gap-s" style="justify-content:center;margin-top:1rem;">
        <wa-button size="small" variant="neutral" ${pagination.page <= 1 ? "disabled" : ""} id="prev-page" aria-label="Previous page">Previous</wa-button>
        <span>Page ${pagination.page} of ${Math.ceil(pagination.total / pagination.limit)}</span>
        <wa-button size="small" variant="neutral" ${pagination.page * pagination.limit >= pagination.total ? "disabled" : ""} id="next-page" aria-label="Next page">Next</wa-button>
      </div>
    ` : ""}
  `;

  container.querySelectorAll("[data-link]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(el.getAttribute("href"));
    });
  });

  container.querySelector("#prev-page")?.addEventListener("click", () => onPageChange(pagination.page - 1));
  container.querySelector("#next-page")?.addEventListener("click", () => onPageChange(pagination.page + 1));

  container.querySelectorAll("[data-href]").forEach((el) => {
    el.addEventListener("click", () => window.open(el.dataset.href, "_blank", "noopener"));
  });
}
