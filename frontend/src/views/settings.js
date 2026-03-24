import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";

function renderDomainRow(domain) {
  return `
    <tr class="domain-row" data-hostname="${escapeAttr(domain.hostname)}">
      <td>${escapeHtml(domain.hostname)}</td>
      <td class="truncate">${escapeHtml(domain.rootRedirect || "—")}</td>
      <td class="truncate">${escapeHtml(domain.notFoundRedirect || "—")}</td>
      <td>
        <wa-badge variant="${domain.accessMode === "restricted" ? "warning" : "success"}" pill>
          ${domain.accessMode === "restricted" ? "Restricted" : "Everyone"}
        </wa-badge>
      </td>
      <td>
        <div class="wa-cluster wa-gap-2xs">
          <wa-button size="small" variant="neutral" appearance="outlined" class="edit-domain-btn" data-hostname="${escapeAttr(domain.hostname)}">
            <wa-icon slot="start" name="pen-to-square"></wa-icon>
            Edit
          </wa-button>
        </div>
      </td>
    </tr>
  `;
}

function renderEditRow(domain) {
  return `
    <tr class="domain-edit-row" data-edit-for="${escapeAttr(domain.hostname)}">
      <td colspan="5">
        <form class="wa-stack wa-gap-s edit-domain-form" data-hostname="${escapeAttr(domain.hostname)}" style="padding:var(--wa-space-xs) 0;">
          <div class="wa-cluster wa-gap-s wa-align-items-end">
            <wa-input name="rootRedirect" label="Root Redirect" placeholder="https://example.com" value="${escapeAttr(domain.rootRedirect || "")}" style="flex:1;min-width:200px;"></wa-input>
            <wa-input name="notFoundRedirect" label="404 Redirect" placeholder="https://example.com/404" value="${escapeAttr(domain.notFoundRedirect || "")}" style="flex:1;min-width:200px;"></wa-input>
            <wa-select name="accessMode" label="Access" style="min-width:140px;">
              <wa-option value="all" ${(domain.accessMode || "all") === "all" ? "selected" : ""}>Everyone</wa-option>
              <wa-option value="restricted" ${domain.accessMode === "restricted" ? "selected" : ""}>Restricted</wa-option>
            </wa-select>
          </div>
          <div class="access-emails-section" style="display:${domain.accessMode === "restricted" ? "block" : "none"};">
            <wa-textarea name="accessEmails" label="Allowed Emails (one per line)" rows="3" placeholder="user@example.com" value="${escapeAttr((domain.accessEmails || []).join("\n"))}"></wa-textarea>
          </div>
          <div class="wa-cluster wa-gap-s">
            <wa-button type="submit" variant="brand" size="small">Save</wa-button>
            <wa-button variant="neutral" size="small" class="cancel-edit-btn">Cancel</wa-button>
          </div>
        </form>
      </td>
    </tr>
  `;
}

export async function renderSettings(container) {
  container.innerHTML = `<div class="text-center" style="padding:var(--wa-space-3xl);"><wa-spinner></wa-spinner></div>`;

  let user;
  try {
    const meRes = await fetch("/api/me");
    if (meRes.status === 401) { window.location.href = "/login"; return; }
    if (meRes.ok) {
      ({ data: user } = await meRes.json());
    }
  } catch {
    showToast("Failed to load user info", "danger");
    return;
  }

  const isAdmin = user?.isAdmin ?? false;

  let domains = [];
  if (isAdmin) {
    try {
      const res = await fetch("/api/domains");
      if (res.ok) {
        ({ data: domains } = await res.json());
      }
    } catch {
      showToast("Failed to load domains", "danger");
    }
  }

  const domainsTab = isAdmin ? `
    <wa-tab panel="domains">Domains</wa-tab>
    <wa-tab-panel name="domains">
      <div class="wa-stack wa-gap-l" style="padding-top:var(--wa-space-m);">
        <wa-card>
          <div class="wa-stack wa-gap-m">
            <div class="wa-split">
              <h3>Configured Domains</h3>
              <wa-button id="sync-domains-btn" variant="brand" size="small">
                <wa-icon slot="start" name="arrows-rotate"></wa-icon>
                Sync from Cloudflare
              </wa-button>
            </div>
            ${domains.length === 0
              ? `<p class="text-quiet">No domains configured. Click "Sync from Cloudflare" to import domains routed to this worker.</p>`
              : `
                <table class="link-table" aria-label="Custom domains">
                  <thead>
                    <tr>
                      <th>Hostname</th>
                      <th>Root Redirect</th>
                      <th>404 Redirect</th>
                      <th>Access</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody id="domains-tbody">
                    ${domains.map(d => renderDomainRow(d)).join("")}
                  </tbody>
                </table>
              `
            }
          </div>
        </wa-card>
      </div>
    </wa-tab-panel>
  ` : "";

  container.innerHTML = `
    <div class="settings-view wa-stack wa-gap-l">
      <h1>Settings</h1>
      ${isAdmin ? `<wa-tab-group>${domainsTab}</wa-tab-group>` : `<p class="text-quiet">No settings available. Admin features will appear here when enabled.</p>`}
    </div>
  `;

  if (!isAdmin) return;

  // Sync domains button
  const syncBtn = container.querySelector("#sync-domains-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      syncBtn.loading = true;
      syncBtn.disabled = true;
      let success = false;
      try {
        const res = await fetch("/api/domains/sync", { method: "POST" });
        const result = await res.json();
        if (!res.ok) {
          showToast(result.message || result.error || "Failed to sync domains", "danger");
          return;
        }
        showToast("Domains synced from Cloudflare", "success");
        success = true;
      } catch {
        showToast("Network error", "danger");
      } finally {
        syncBtn.loading = false;
        syncBtn.disabled = false;
      }
      if (success) renderSettings(container);
    });
  }

  // Edit domain
  container.querySelectorAll(".edit-domain-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const hostname = btn.dataset.hostname;

      // Remove any existing edit rows
      container.querySelectorAll(".domain-edit-row").forEach(r => r.remove());

      // Fetch domain details with access list
      let domainDetail;
      try {
        const res = await fetch(`/api/domains/${encodeURIComponent(hostname)}`);
        if (!res.ok) {
          showToast("Failed to load domain details", "danger");
          return;
        }
        ({ data: domainDetail } = await res.json());
      } catch {
        showToast("Network error", "danger");
        return;
      }

      const row = btn.closest("tr");
      row.insertAdjacentHTML("afterend", renderEditRow(domainDetail));

      const editForm = container.querySelector(`.edit-domain-form[data-hostname="${CSS.escape(hostname)}"]`);

      // Toggle email section visibility based on access mode
      const accessSelect = editForm.querySelector('[name="accessMode"]');
      const emailsSection = editForm.querySelector(".access-emails-section");
      accessSelect.addEventListener("change", () => {
        emailsSection.style.display = accessSelect.value === "restricted" ? "block" : "none";
      });

      editForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = editForm.querySelector('wa-button[type="submit"]');
        submitBtn.loading = true;
        submitBtn.disabled = true;

        const rootRedirect = editForm.querySelector('[name="rootRedirect"]').value.trim() || null;
        const notFoundRedirect = editForm.querySelector('[name="notFoundRedirect"]').value.trim() || null;
        const accessMode = editForm.querySelector('[name="accessMode"]').value;
        let success = false;

        try {
          const configRes = await fetch(`/api/domains/${encodeURIComponent(hostname)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rootRedirect, notFoundRedirect, accessMode }),
          });
          if (!configRes.ok) {
            const result = await configRes.json();
            showToast(result.message || result.error || "Failed to update domain", "danger");
            return;
          }

          if (accessMode === "restricted") {
            const emailsText = editForm.querySelector('[name="accessEmails"]').value;
            const emails = emailsText.split("\n").map(e => e.trim()).filter(Boolean);
            const accessRes = await fetch(`/api/domains/${encodeURIComponent(hostname)}/access`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ emails }),
            });
            if (!accessRes.ok) {
              showToast("Domain updated but access list failed to save", "warning");
              return;
            }
          }

          showToast("Domain updated", "success");
          success = true;
        } catch {
          showToast("Network error", "danger");
        } finally {
          submitBtn.loading = false;
          submitBtn.disabled = false;
        }
        if (success) renderSettings(container);
      });

      editForm.querySelector(".cancel-edit-btn").addEventListener("click", () => {
        editForm.closest("tr").remove();
      });
    });
  });
}
