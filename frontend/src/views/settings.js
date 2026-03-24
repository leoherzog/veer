import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { authClient } from "../auth-client.js";

/* ── API Keys helpers ─────────────────────────────────────────────── */

function renderKeyRow(key) {
  const createdAt = key.createdAt ? `<wa-relative-time date="${escapeAttr(key.createdAt)}"></wa-relative-time>` : "—";
  const lastUsed = key.lastUsedAt ? `<wa-relative-time date="${escapeAttr(key.lastUsedAt)}"></wa-relative-time>` : "Never";
  const expires = key.expiresAt ? `<wa-relative-time date="${escapeAttr(key.expiresAt)}"></wa-relative-time>` : "Never";
  return `
    <tr>
      <td>${escapeHtml(key.name)}</td>
      <td><code>${escapeHtml(key.prefix)}...</code></td>
      <td>${createdAt}</td>
      <td>${lastUsed}</td>
      <td>${expires}</td>
      <td>
        <wa-button size="small" variant="danger" appearance="outlined" class="delete-key-btn" data-id="${escapeAttr(key.id)}" data-name="${escapeAttr(key.name)}">
          <wa-icon slot="start" name="trash"></wa-icon>
          Delete
        </wa-button>
      </td>
    </tr>
  `;
}

function renderApiKeysPanel(keys) {
  return `
    <wa-tab-panel name="api-keys">
      <div class="wa-stack wa-gap-l" style="padding-top:var(--wa-space-m);">
        <wa-card>
          <div class="wa-stack wa-gap-m">
            <h3>Create API Key</h3>
            <form id="create-key-form" class="wa-cluster wa-gap-s wa-align-items-end">
              <wa-input id="key-name" name="name" label="Name" placeholder="e.g. CI deploy" required style="flex:1;min-width:180px;"></wa-input>
              <wa-input id="key-expires" name="expiresAt" type="date" label="Expires (optional)" style="min-width:160px;"></wa-input>
              <wa-button type="submit" variant="brand" size="small">
                <wa-icon slot="start" name="plus"></wa-icon>
                Create
              </wa-button>
            </form>
            <div id="new-key-callout" style="display:none;"></div>
          </div>
        </wa-card>

        <wa-card>
          <div class="wa-stack wa-gap-m">
            <h3>Existing Keys</h3>
            ${keys.length === 0
              ? `<p class="wa-color-text-quiet">No API keys yet.</p>`
              : `
                <table class="link-table" aria-label="API keys">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Prefix</th>
                      <th>Created</th>
                      <th>Last Used</th>
                      <th>Expires</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody id="keys-tbody">
                    ${keys.map(k => renderKeyRow(k)).join("")}
                  </tbody>
                </table>
              `
            }
          </div>
        </wa-card>
      </div>
    </wa-tab-panel>
  `;
}

function bindDeleteKeyButtons(container) {
  container.querySelectorAll(".delete-key-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dialog = container.querySelector("#delete-key-dialog");
      const nameEl = container.querySelector("#delete-key-name");
      nameEl.textContent = btn.dataset.name;
      dialog.dataset.keyId = btn.dataset.id;
      dialog.open = true;
    });
  });
}

function bindDeleteKeyDialog(container) {
  const dialog = container.querySelector("#delete-key-dialog");
  if (dialog) {
    const cancelBtn = container.querySelector("#cancel-delete-key");
    const confirmBtn = container.querySelector("#confirm-delete-key");

    cancelBtn.addEventListener("click", () => { dialog.open = false; });
    confirmBtn.addEventListener("click", async () => {
      const keyId = dialog.dataset.keyId;
      confirmBtn.loading = true;
      confirmBtn.disabled = true;
      try {
        const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
        if (res.ok || res.status === 204) {
          showToast("API key deleted", "success");
          dialog.open = false;
          renderSettings(container);
        } else {
          const result = await res.json().catch(() => ({}));
          showToast(result.message || result.error || "Failed to delete key", "danger");
        }
      } catch {
        showToast("Network error", "danger");
      } finally {
        confirmBtn.loading = false;
        confirmBtn.disabled = false;
      }
    });
  }
}

/* ── Passkey helpers ──────────────────────────────────────────────── */

function renderPasskeyRow(pk) {
  const created = pk.createdAt ? `<wa-relative-time date="${escapeAttr(pk.createdAt)}"></wa-relative-time>` : "—";
  return `
    <tr>
      <td>${escapeHtml(pk.name || "Unnamed passkey")}</td>
      <td><code>${escapeHtml(pk.credentialID?.slice(0, 16) || pk.id.slice(0, 8))}…</code></td>
      <td>${created}</td>
      <td>
        <wa-button size="small" variant="danger" appearance="outlined" class="delete-passkey-btn" data-id="${escapeAttr(pk.id)}" data-name="${escapeAttr(pk.name || "Unnamed")}">
          <wa-icon slot="start" name="trash"></wa-icon>
          Delete
        </wa-button>
      </td>
    </tr>
  `;
}

function renderPasskeyPanel(passkeys) {
  return `
    <wa-tab-panel name="passkeys">
      <div class="wa-stack wa-gap-l" style="padding-top:var(--wa-space-m);">
        <wa-card>
          <div class="wa-stack wa-gap-m">
            <h3>Register Passkey</h3>
            <p class="wa-color-text-quiet">Passkeys let you sign in securely without a password using your device's biometrics or security key.</p>
            <form id="register-passkey-form" class="wa-cluster wa-gap-s wa-align-items-end">
              <wa-input id="passkey-name" name="name" label="Passkey Name" placeholder="e.g. MacBook Touch ID" required style="flex:1;min-width:200px;"></wa-input>
              <wa-button type="submit" variant="brand" size="small">
                <wa-icon slot="start" name="key"></wa-icon>
                Register
              </wa-button>
            </form>
          </div>
        </wa-card>

        <wa-card>
          <div class="wa-stack wa-gap-m">
            <h3>Registered Passkeys</h3>
            ${passkeys.length === 0
              ? `<p class="wa-color-text-quiet">No passkeys registered yet.</p>`
              : `
                <table class="link-table" aria-label="Passkeys">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Credential</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody id="passkeys-tbody">
                    ${passkeys.map(pk => renderPasskeyRow(pk)).join("")}
                  </tbody>
                </table>
              `
            }
          </div>
        </wa-card>
      </div>

      <wa-dialog id="delete-passkey-dialog" label="Delete Passkey">
        <p>Are you sure you want to delete the passkey <strong id="delete-passkey-name"></strong>? You won't be able to sign in with it anymore.</p>
        <wa-button slot="footer" variant="neutral" id="cancel-delete-passkey">Cancel</wa-button>
        <wa-button slot="footer" variant="danger" id="confirm-delete-passkey">Delete</wa-button>
      </wa-dialog>
    </wa-tab-panel>
  `;
}

function bindPasskeyRegister(container) {
  const form = container.querySelector("#register-passkey-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = form.querySelector("#passkey-name");
    const submitBtn = form.querySelector('wa-button[type="submit"]');
    const name = nameInput.value.trim();
    if (!name) { showToast("Name is required", "warning"); return; }

    submitBtn.loading = true;
    submitBtn.disabled = true;

    try {
      const result = await authClient.passkey.addPasskey({ name });
      if (result.error) {
        showToast(result.error.message || "Failed to register passkey", "danger");
        return;
      }
      showToast("Passkey registered", "success");
      renderSettings(container);
    } catch (err) {
      // User may have cancelled the WebAuthn prompt
      if (err?.name === "NotAllowedError") {
        showToast("Passkey registration cancelled", "warning");
      } else {
        showToast("Failed to register passkey", "danger");
      }
    } finally {
      submitBtn.loading = false;
      submitBtn.disabled = false;
    }
  });
}

function bindPasskeyDelete(container) {
  const dialog = container.querySelector("#delete-passkey-dialog");
  if (!dialog) return;

  container.querySelectorAll(".delete-passkey-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nameEl = container.querySelector("#delete-passkey-name");
      nameEl.textContent = btn.dataset.name;
      dialog.dataset.passkeyId = btn.dataset.id;
      dialog.open = true;
    });
  });

  const cancelBtn = container.querySelector("#cancel-delete-passkey");
  const confirmBtn = container.querySelector("#confirm-delete-passkey");

  cancelBtn.addEventListener("click", () => { dialog.open = false; });
  confirmBtn.addEventListener("click", async () => {
    const passkeyId = dialog.dataset.passkeyId;
    confirmBtn.loading = true;
    confirmBtn.disabled = true;
    try {
      const res = await fetch("/api/auth/passkey/delete-passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: passkeyId }),
      });
      if (res.ok) {
        showToast("Passkey deleted", "success");
        dialog.open = false;
        renderSettings(container);
      } else {
        const result = await res.json().catch(() => ({}));
        showToast(result.message || result.error || "Failed to delete passkey", "danger");
      }
    } catch {
      showToast("Network error", "danger");
    } finally {
      confirmBtn.loading = false;
      confirmBtn.disabled = false;
    }
  });
}

/* ── Domain helpers ───────────────────────────────────────────────── */

function renderDomainRow(domain) {
  return `
    <tr class="domain-row" data-hostname="${escapeAttr(domain.hostname)}">
      <td>${escapeHtml(domain.hostname)}</td>
      <td class="text-truncate">${escapeHtml(domain.rootRedirect || "—")}</td>
      <td class="text-truncate">${escapeHtml(domain.notFoundRedirect || "—")}</td>
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
  container.innerHTML = `<div class="wa-stack wa-align-items-center" style="padding:var(--wa-space-3xl);"><wa-spinner></wa-spinner></div>`;

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

  // Fetch API keys for all users
  let apiKeys = [];
  try {
    const keysRes = await fetch("/api/keys");
    if (keysRes.ok) {
      ({ data: apiKeys } = await keysRes.json());
    }
  } catch {
    showToast("Failed to load API keys", "danger");
  }

  // Check if passkeys are enabled and fetch user's passkeys
  let passkeyEnabled = false;
  let passkeys = [];
  try {
    const provRes = await fetch("/api/auth/providers");
    if (provRes.ok) {
      const provData = await provRes.json();
      passkeyEnabled = provData.passkey === true;
    }
  } catch { /* ignore */ }

  if (passkeyEnabled) {
    try {
      const pkRes = await fetch("/api/auth/passkey/list-user-passkeys");
      if (pkRes.ok) {
        const pkData = await pkRes.json();
        passkeys = Array.isArray(pkData) ? pkData : (pkData.data ?? []);
      }
    } catch {
      showToast("Failed to load passkeys", "danger");
    }
  }

  const passkeysTab = passkeyEnabled ? `
    <wa-tab panel="passkeys">Passkeys</wa-tab>
  ` : "";

  const passkeysPanel = passkeyEnabled ? renderPasskeyPanel(passkeys) : "";

  const domainsTab = isAdmin ? `
    <wa-tab panel="domains">Domains</wa-tab>
  ` : "";

  const domainsPanel = isAdmin ? `
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
              ? `<p class="wa-color-text-quiet">No domains configured. Click "Sync from Cloudflare" to import domains routed to this worker.</p>`
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
      <wa-tab-group>
        <wa-tab panel="api-keys">API Keys</wa-tab>
        ${passkeysTab}
        ${domainsTab}
        ${renderApiKeysPanel(apiKeys)}
        ${passkeysPanel}
        ${domainsPanel}
      </wa-tab-group>
      <wa-dialog id="delete-key-dialog" label="Delete API Key">
        <p>Are you sure you want to delete the key <strong id="delete-key-name"></strong>? This cannot be undone.</p>
        <wa-button slot="footer" variant="neutral" id="cancel-delete-key">Cancel</wa-button>
        <wa-button slot="footer" variant="danger" id="confirm-delete-key">Delete</wa-button>
      </wa-dialog>
    </div>
  `;

  // ── API Keys event handlers ──────────────────────────────────────
  const createKeyForm = container.querySelector("#create-key-form");
  if (createKeyForm) {
    createKeyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = createKeyForm.querySelector('wa-button[type="submit"]');
      const nameInput = createKeyForm.querySelector("#key-name");
      const expiresInput = createKeyForm.querySelector("#key-expires");

      const name = nameInput.value.trim();
      if (!name) { showToast("Name is required", "warning"); return; }

      submitBtn.loading = true;
      submitBtn.disabled = true;

      const body = { name };
      const expiresVal = expiresInput.value;
      if (expiresVal) body.expiresAt = new Date(expiresVal).toISOString();

      try {
        const res = await fetch("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await res.json();
        if (!res.ok) {
          showToast(result.message || result.error || "Failed to create key", "danger");
          return;
        }

        // Show the newly created key
        const callout = container.querySelector("#new-key-callout");
        callout.style.display = "block";
        callout.innerHTML = `
          <wa-callout variant="warning">
            <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
            <strong>Copy your API key now — it will not be shown again.</strong>
            <div class="wa-cluster wa-gap-xs" style="margin-top:var(--wa-space-xs);">
              <code style="word-break:break-all;">${escapeHtml(result.data.key)}</code>
              <wa-copy-button value="${escapeAttr(result.data.key)}"></wa-copy-button>
            </div>
          </wa-callout>
        `;

        // Reset form and refresh key list
        nameInput.value = "";
        expiresInput.value = "";

        // Re-fetch and update the keys table
        const keysRes = await fetch("/api/keys");
        if (keysRes.ok) {
          const { data: updatedKeys } = await keysRes.json();
          const keysCard = container.querySelectorAll("wa-tab-panel[name='api-keys'] wa-card")[1];
          if (keysCard) {
            const inner = keysCard.querySelector(".wa-stack");
            inner.innerHTML = `
              <h3>Existing Keys</h3>
              ${updatedKeys.length === 0
                ? `<p class="wa-color-text-quiet">No API keys yet.</p>`
                : `
                  <table class="link-table" aria-label="API keys">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Prefix</th>
                        <th>Created</th>
                        <th>Last Used</th>
                        <th>Expires</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody id="keys-tbody">
                      ${updatedKeys.map(k => renderKeyRow(k)).join("")}
                    </tbody>
                  </table>
                `
              }
            `;
            bindDeleteKeyButtons(container);
          }
        }

        showToast("API key created", "success");
      } catch {
        showToast("Network error", "danger");
      } finally {
        submitBtn.loading = false;
        submitBtn.disabled = false;
      }
    });
  }

  bindDeleteKeyButtons(container);
  bindDeleteKeyDialog(container);

  // Passkey event handlers
  if (passkeyEnabled) {
    bindPasskeyRegister(container);
    bindPasskeyDelete(container);
  }

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
