import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { authClient } from "../auth-client.js";
import { SPINNER, apiFetch, withLoadingBtn, bindConfirmDialog, renderTable } from "../lib/ui.js";

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
        <wa-button size="s" variant="danger" appearance="outlined" class="delete-key-btn" data-id="${escapeAttr(key.id)}" data-name="${escapeAttr(key.name)}">
          <wa-icon slot="start" name="trash"></wa-icon>
          Delete
        </wa-button>
      </td>
    </tr>
  `;
}

function renderKeysList(keys) {
  return keys.length === 0
    ? `<p class="wa-color-text-quiet">No API keys yet.</p>`
    : renderTable({
      label: "API keys",
      columns: ["Name", "Prefix", "Created", "Last Used", "Expires", "Actions"],
      rows: keys.map(k => renderKeyRow(k)),
      tbodyId: "keys-tbody",
    });
}

function renderApiKeysPanel(keys) {
  return `
    <wa-tab-panel name="api-keys">
      <div class="wa-stack wa-gap-l">
        <wa-card>
          <h3 slot="header">Create API Key</h3>
          <div class="wa-stack wa-gap-m">
            <form id="create-key-form" class="wa-cluster wa-gap-s wa-align-items-end">
              <wa-input id="key-name" name="name" label="Name" placeholder="e.g. CI deploy" required pattern=".*\\S.*" title="Name is required" style="flex:1;min-width:180px;"></wa-input>
              <wa-input id="key-expires" name="expiresAt" type="date" label="Expires (optional)" style="min-width:160px;"></wa-input>
              <wa-button type="submit" variant="brand" size="s">
                <wa-icon slot="start" name="plus"></wa-icon>
                Create
              </wa-button>
            </form>
            <div id="new-key-callout" style="display:none;"></div>
          </div>
        </wa-card>

        <wa-card>
          <h3 slot="header">Existing Keys</h3>
          <div id="existing-keys">
            ${renderKeysList(keys)}
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
  if (!dialog) return;
  bindConfirmDialog({
    dialog,
    confirmBtn: container.querySelector("#confirm-delete-key"),
    onConfirm: async () => {
      const result = await apiFetch(`/api/keys/${encodeURIComponent(dialog.dataset.keyId)}`, { method: "DELETE" });
      if (!result) return false;
      showToast("API key deleted", "success");
      renderSettings(container);
    },
  });
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
        <wa-button size="s" variant="danger" appearance="outlined" class="delete-passkey-btn" data-id="${escapeAttr(pk.id)}" data-name="${escapeAttr(pk.name || "Unnamed")}">
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
      <div class="wa-stack wa-gap-l">
        <wa-card>
          <h3 slot="header">Register Passkey</h3>
          <div class="wa-stack wa-gap-m">
            <p class="wa-color-text-quiet">Passkeys let you sign in securely without a password using your device's biometrics or security key.</p>
            <form id="register-passkey-form" class="wa-cluster wa-gap-s wa-align-items-end">
              <wa-input id="passkey-name" name="name" label="Passkey Name" placeholder="e.g. MacBook Touch ID" required pattern=".*\\S.*" title="Name is required" style="flex:1;min-width:200px;"></wa-input>
              <wa-button type="submit" variant="brand" size="s">
                <wa-icon slot="start" name="key"></wa-icon>
                Register
              </wa-button>
            </form>
          </div>
        </wa-card>

        <wa-card>
          <h3 slot="header">Registered Passkeys</h3>
          ${passkeys.length === 0
            ? `<p class="wa-color-text-quiet">No passkeys registered yet.</p>`
            : renderTable({
              label: "Passkeys",
              columns: ["Name", "Credential", "Created", "Actions"],
              rows: passkeys.map(pk => renderPasskeyRow(pk)),
              tbodyId: "passkeys-tbody",
            })
          }
        </wa-card>
      </div>

      <wa-dialog id="delete-passkey-dialog" label="Delete Passkey">
        <p>Are you sure you want to delete the passkey <strong id="delete-passkey-name"></strong>? You won't be able to sign in with it anymore.</p>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
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

    await withLoadingBtn(submitBtn, async () => {
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
      }
    });
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

  bindConfirmDialog({
    dialog,
    confirmBtn: container.querySelector("#confirm-delete-passkey"),
    onConfirm: async () => {
      try {
        const result = await authClient.passkey.deletePasskey({ id: dialog.dataset.passkeyId });
        if (result?.error) {
          showToast(result.error.message || "Failed to delete passkey", "danger");
          return false;
        }
        showToast("Passkey deleted", "success");
        renderSettings(container);
      } catch {
        showToast("Network error", "danger");
        return false;
      }
    },
  });
}

/* ── Domain helpers ───────────────────────────────────────────────── */

function renderDomainRow(domain) {
  return `
    <tr>
      <td>${escapeHtml(domain.hostname)}</td>
      <td class="text-truncate wa-text-truncate">${escapeHtml(domain.rootRedirect || "—")}</td>
      <td class="text-truncate wa-text-truncate">${escapeHtml(domain.notFoundRedirect || "—")}</td>
      <td>
        <wa-badge variant="${domain.accessMode === "restricted" ? "warning" : "success"}" pill>
          ${domain.accessMode === "restricted" ? "Restricted" : "Everyone"}
        </wa-badge>
      </td>
      <td>
        <div class="wa-cluster wa-gap-2xs">
          <wa-button size="s" variant="neutral" appearance="outlined" class="edit-domain-btn" data-hostname="${escapeAttr(domain.hostname)}">
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
    <tr class="domain-edit-row">
      <td colspan="5">
        <form class="wa-stack wa-gap-s edit-domain-form" data-hostname="${escapeAttr(domain.hostname)}">
          <div class="wa-cluster wa-gap-s wa-align-items-end">
            <wa-input name="rootRedirect" label="Root Redirect" placeholder="https://example.com" value="${escapeAttr(domain.rootRedirect || "")}" style="flex:1;min-width:200px;"></wa-input>
            <wa-input name="notFoundRedirect" label="404 Redirect" placeholder="https://example.com/404" value="${escapeAttr(domain.notFoundRedirect || "")}" style="flex:1;min-width:200px;"></wa-input>
            <wa-select name="accessMode" label="Access" style="min-width:140px;">
              <wa-option value="all" ${(domain.accessMode || "all") === "all" ? "selected" : ""}>Everyone</wa-option>
              <wa-option value="restricted" ${domain.accessMode === "restricted" ? "selected" : ""}>Restricted</wa-option>
            </wa-select>
          </div>
          <div class="access-emails-section" style="display:${domain.accessMode === "restricted" ? "block" : "none"};">
            <wa-textarea name="accessEmails" label="Allowed Emails (one per line)" rows="3" placeholder="user@example.com" value="${escapeAttr((domain.accessEmails || []).join("\n")).replace(/\n/g, "&#10;")}"></wa-textarea>
          </div>
          <div class="wa-cluster wa-gap-s">
            <wa-button type="submit" variant="brand" size="s">Save</wa-button>
            <wa-button variant="neutral" size="s" class="cancel-edit-btn">Cancel</wa-button>
          </div>
        </form>
      </td>
    </tr>
  `;
}

export async function renderSettings(container) {
  container.innerHTML = SPINNER;

  const meResult = await apiFetch("/api/me");
  if (!meResult) return;
  const { data: user } = meResult;

  const isAdmin = user?.isAdmin ?? false;

  let domains = [];
  if (isAdmin) {
    const domainsResult = await apiFetch("/api/domains").catch(() => null);
    if (domainsResult?.data) domains = domainsResult.data;
  }

  // Fetch API keys for all users
  let apiKeys = [];
  const keysResult = await apiFetch("/api/keys").catch(() => null);
  if (keysResult?.data) apiKeys = keysResult.data;

  // Check if passkeys are enabled and fetch user's passkeys
  let passkeyEnabled = false;
  let passkeys = [];
  const provResult = await apiFetch("/api/auth/providers").catch(() => null);
  if (provResult) passkeyEnabled = provResult.passkey === true;

  if (passkeyEnabled) {
    const pkResult = await apiFetch("/api/auth/passkey/list-user-passkeys").catch(() => null);
    if (pkResult) {
      passkeys = Array.isArray(pkResult) ? pkResult : (pkResult.data ?? []);
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
      <div class="wa-stack wa-gap-l">
        <wa-card>
          <h3 slot="header">Configured Domains</h3>
          <wa-button slot="header-actions" id="sync-domains-btn" variant="brand" size="s">
            <wa-icon slot="start" name="arrows-rotate"></wa-icon>
            Sync from Cloudflare
          </wa-button>
          ${domains.length === 0
            ? `<p class="wa-color-text-quiet">No domains configured. Click "Sync from Cloudflare" to import domains routed to this worker.</p>`
            : renderTable({
              label: "Custom domains",
              columns: ["Hostname", "Root Redirect", "404 Redirect", "Access", "Actions"],
              rows: domains.map(d => renderDomainRow(d)),
              tbodyId: "domains-tbody",
            })
          }
        </wa-card>
      </div>
    </wa-tab-panel>
  ` : "";

  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <h1>Settings</h1>
      <wa-tab-group without-scroll-controls>
        <wa-tab panel="api-keys">API Keys</wa-tab>
        ${passkeysTab}
        ${domainsTab}
        ${renderApiKeysPanel(apiKeys)}
        ${passkeysPanel}
        ${domainsPanel}
      </wa-tab-group>
      <wa-dialog id="delete-key-dialog" label="Delete API Key">
        <p>Are you sure you want to delete the key <strong id="delete-key-name"></strong>? This cannot be undone.</p>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
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

      const body = { name };
      const expiresVal = expiresInput.value;
      if (expiresVal) body.expiresAt = new Date(expiresVal).toISOString();

      await withLoadingBtn(submitBtn, async () => {
        const result = await apiFetch("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!result) return;

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
        const keysResult = await apiFetch("/api/keys").catch(() => null);
        if (keysResult?.data) {
          const list = container.querySelector("#existing-keys");
          if (list) {
            list.innerHTML = renderKeysList(keysResult.data);
            bindDeleteKeyButtons(container);
          }
        }

        showToast("API key created", "success");
      });
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
      let success = false;
      await withLoadingBtn(syncBtn, async () => {
        const res = await apiFetch("/api/domains/sync", { method: "POST" });
        if (!res) return;
        showToast("Domains synced from Cloudflare", "success");
        success = true;
      });
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
      const detailResult = await apiFetch(`/api/domains/${encodeURIComponent(hostname)}`);
      if (!detailResult) return;
      const domainDetail = detailResult.data;

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

        const rootRedirect = editForm.querySelector('[name="rootRedirect"]').value.trim() || null;
        const notFoundRedirect = editForm.querySelector('[name="notFoundRedirect"]').value.trim() || null;
        const accessMode = editForm.querySelector('[name="accessMode"]').value;
        let success = false;

        await withLoadingBtn(submitBtn, async () => {
          const configRes = await apiFetch(`/api/domains/${encodeURIComponent(hostname)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rootRedirect, notFoundRedirect, accessMode }),
          });
          if (!configRes) return;

          if (accessMode === "restricted") {
            const emailsText = editForm.querySelector('[name="accessEmails"]').value;
            const emails = emailsText.split("\n").map(e => e.trim()).filter(Boolean);
            const accessRes = await apiFetch(`/api/domains/${encodeURIComponent(hostname)}/access`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ emails }),
            });
            if (!accessRes) {
              showToast("Domain updated but access list failed to save", "warning");
              return;
            }
          }

          showToast("Domain updated", "success");
          success = true;
        });
        if (success) renderSettings(container);
      });

      editForm.querySelector(".cancel-edit-btn").addEventListener("click", () => {
        editForm.closest("tr").remove();
      });
    });
  });
}
