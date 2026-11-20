import { showToast } from "../components/toast.js";
import { escapeAttr, escapeHtml } from "../lib/escape.js";
import { authClient, isPasskeyCancel } from "../auth-client.js";
import { isDemoMode, isPasskeyEnabled } from "../lib/config.js";
import {
  SPINNER, apiFetch, withLoadingBtn, bindConfirmDialog, renderTable, relativeTime,
  loadTableSection, delegateClick, errorCallout, secretCallout,
} from "../lib/ui.js";

/** Today's local calendar date as YYYY-MM-DD, the form a date input's `min` takes. */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ── API keys ─────────────────────────────────────────────────────── */

function renderKeyRow(key) {
  return `
    <tr>
      <td>${escapeHtml(key.name)}</td>
      <td><code>${escapeHtml(key.prefix)}...</code></td>
      <td>${relativeTime(key.createdAt)}</td>
      <td>${relativeTime(key.lastUsedAt, "Never")}</td>
      <td>${relativeTime(key.expiresAt, "Never")}</td>
      <td>
        <wa-button size="s" variant="danger" appearance="outlined" class="delete-key-btn" data-dialog="open delete-key-dialog" data-id="${escapeAttr(key.id)}" data-name="${escapeAttr(key.name)}">
          <wa-icon slot="start" name="trash"></wa-icon>
          Delete
        </wa-button>
      </td>
    </tr>
  `;
}

function apiKeysPanel() {
  return `
    <wa-tab-panel name="api-keys">
      <div class="wa-stack wa-gap-l">
        <wa-card>
          <h3 slot="header">Create API Key</h3>
          <div class="wa-stack wa-gap-m">
            <form id="create-key-form" class="wa-cluster wa-gap-s wa-align-items-end">
              <wa-input name="name" label="Name" placeholder="e.g. CI deploy" required pattern=".*\\S.*" title="Name is required" style="flex:1;min-width:180px;"></wa-input>
              <wa-input name="expiresAt" type="date" min="${localToday()}" label="Expires (optional)" style="min-width:160px;"></wa-input>
              <wa-button type="submit" variant="brand" size="s">
                <wa-icon slot="start" name="plus"></wa-icon>
                Create
              </wa-button>
            </form>
            <div id="new-key-callout" hidden></div>
          </div>
        </wa-card>

        <wa-card>
          <h3 slot="header">Existing Keys</h3>
          <div id="existing-keys"></div>
        </wa-card>
      </div>
    </wa-tab-panel>
  `;
}

function bindApiKeys(container) {
  const list = container.querySelector("#existing-keys");
  const dialog = container.querySelector("#delete-key-dialog");
  const form = container.querySelector("#create-key-form");
  const submitBtn = form.querySelector('wa-button[type="submit"]');
  const callout = container.querySelector("#new-key-callout");

  const loadKeys = () => loadTableSection(list, {
    url: "/api/keys",
    label: "API keys",
    headers: ["Name", "Prefix", "Created", "Last Used", "Expires", "Actions"],
    renderRow: renderKeyRow,
    empty: "No API keys yet.",
    error: "Failed to load API keys.",
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = new FormData(form);
    const expires = fields.get("expiresAt");
    const body = { name: String(fields.get("name")).trim() };
    // A date-only string parses as UTC midnight, while a date-time without an
    // offset parses as local time, so the key expires at the end of the chosen local day.
    if (expires) body.expiresAt = new Date(`${expires}T23:59:59.999`).toISOString();

    await withLoadingBtn(submitBtn, async () => {
      const result = await apiFetch("/api/keys", { method: "POST", json: body });
      if (!result) return;
      callout.innerHTML = secretCallout({
        variant: "warning",
        icon: "triangle-exclamation",
        value: result.data.key,
        before: "<strong>Copy your API key now — it will not be shown again.</strong>",
      });
      callout.hidden = false;
      form.reset();
      showToast("API key created", "success");
      loadKeys();
    });
  });

  delegateClick(list, ".delete-key-btn", (btn) => {
    container.querySelector("#delete-key-name").textContent = btn.dataset.name;
    dialog.dataset.keyId = btn.dataset.id;
  });

  bindConfirmDialog({
    dialog,
    confirmBtn: container.querySelector("#confirm-delete-key"),
    onConfirm: async () => {
      const result = await apiFetch(`/api/keys/${encodeURIComponent(dialog.dataset.keyId)}`, { method: "DELETE" });
      if (!result) return false;
      showToast("API key deleted", "success");
      loadKeys();
    },
  });

  loadKeys();
}

/* ── Passkeys ─────────────────────────────────────────────────────── */

function renderPasskeyRow(pk) {
  const name = pk.name || "Unnamed passkey";
  // The auth client revives ISO timestamps into Date objects.
  const created = pk.createdAt && new Date(pk.createdAt).toISOString();
  return `
    <tr>
      <td>${escapeHtml(name)}</td>
      <td><code>${escapeHtml(pk.credentialID.slice(0, 16))}…</code></td>
      <td>${relativeTime(created)}</td>
      <td>
        <wa-button size="s" variant="danger" appearance="outlined" class="delete-passkey-btn" data-dialog="open delete-passkey-dialog" data-id="${escapeAttr(pk.id)}" data-name="${escapeAttr(name)}">
          <wa-icon slot="start" name="trash"></wa-icon>
          Delete
        </wa-button>
      </td>
    </tr>
  `;
}

const PASSKEYS_PANEL = `
  <wa-tab-panel name="passkeys">
    <div class="wa-stack wa-gap-l">
      <wa-card>
        <h3 slot="header">Register Passkey</h3>
        <div class="wa-stack wa-gap-m">
          <p class="wa-color-text-quiet">Passkeys let you sign in securely without a password using your device's biometrics or security key.</p>
          <form id="register-passkey-form" class="wa-flank:end wa-gap-s wa-align-items-end">
            <wa-input name="name" label="Passkey Name" placeholder="e.g. MacBook Touch ID" required pattern=".*\\S.*" title="Name is required"></wa-input>
            <wa-button type="submit" variant="brand" size="s">
              <wa-icon slot="start" name="key"></wa-icon>
              Register
            </wa-button>
          </form>
        </div>
      </wa-card>

      <wa-card>
        <h3 slot="header">Registered Passkeys</h3>
        <div id="passkeys-list"></div>
      </wa-card>
    </div>
  </wa-tab-panel>
`;

function bindPasskeys(container) {
  const list = container.querySelector("#passkeys-list");
  const dialog = container.querySelector("#delete-passkey-dialog");
  const form = container.querySelector("#register-passkey-form");
  const submitBtn = form.querySelector('wa-button[type="submit"]');
  const empty = `<p class="wa-color-text-quiet">No passkeys registered yet.</p>`;

  // Counts loads so a slower, older response cannot overwrite a newer one.
  let loads = 0;
  async function loadPasskeys() {
    const load = ++loads;
    // Better Auth has no session in demo mode, so the list would answer 401.
    if (isDemoMode()) { list.innerHTML = empty; return; }
    list.innerHTML = SPINNER;
    const { data, error } = await authClient.passkey.listUserPasskeys().catch((e) => ({ error: e }));
    if (load !== loads) return;
    if (error) {
      showToast(error.message || "Failed to load passkeys", "danger");
      list.innerHTML = errorCallout("Failed to load passkeys.");
      return;
    }
    list.innerHTML = data.length
      ? renderTable({ label: "Passkeys", columns: ["Name", "Credential", "Created", "Actions"], rows: data.map(renderPasskeyRow) })
      : empty;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = String(new FormData(form).get("name")).trim();

    await withLoadingBtn(submitBtn, async () => {
      try {
        // The nickname is set afterwards: addPasskey's `name` also becomes the
        // WebAuthn account name the OS passkey picker shows.
        const { data, error } = await authClient.passkey.addPasskey();
        if (error) {
          if (isPasskeyCancel(error)) showToast("Passkey registration cancelled", "warning");
          else showToast(error.message || "Failed to register passkey", "danger");
          return;
        }
        const renamed = await authClient.passkey.updatePasskey({ id: data.id, name }).catch((e) => ({ error: e }));
        if (renamed.error) showToast("Passkey registered, but its name could not be saved", "warning");
        else showToast("Passkey registered", "success");
        form.reset();
        loadPasskeys();
      } catch {
        showToast("Failed to register passkey", "danger");
      }
    });
  });

  delegateClick(list, ".delete-passkey-btn", (btn) => {
    container.querySelector("#delete-passkey-name").textContent = btn.dataset.name;
    dialog.dataset.passkeyId = btn.dataset.id;
  });

  bindConfirmDialog({
    dialog,
    confirmBtn: container.querySelector("#confirm-delete-passkey"),
    onConfirm: async () => {
      try {
        const { error } = await authClient.passkey.deletePasskey({ id: dialog.dataset.passkeyId });
        if (error) {
          showToast(error.message || "Failed to delete passkey", "danger");
          return false;
        }
        showToast("Passkey deleted", "success");
        loadPasskeys();
      } catch {
        showToast("Network error", "danger");
        return false;
      }
    },
  });

  loadPasskeys();
}

/* ── Domains ──────────────────────────────────────────────────────── */

function renderDomainRow(domain) {
  const restricted = domain.accessMode === "restricted";
  // Nothing applies the primary host's redirects or access mode, so it has no Edit.
  const edit = domain.isPrimary ? "" : `
    <wa-button size="s" variant="neutral" appearance="outlined" class="edit-domain-btn" data-hostname="${escapeAttr(domain.hostname)}">
      <wa-icon slot="start" name="pen-to-square"></wa-icon>
      Edit
    </wa-button>
  `;
  return `
    <tr>
      <td>
        <div class="wa-cluster wa-gap-2xs">
          ${escapeHtml(domain.hostname)}
          ${domain.isPrimary ? `<wa-badge variant="brand" pill>Primary</wa-badge>` : ""}
        </div>
      </td>
      <td class="text-truncate wa-text-truncate">${escapeHtml(domain.rootRedirect || "—")}</td>
      <td class="text-truncate wa-text-truncate">${escapeHtml(domain.notFoundRedirect || "—")}</td>
      <td>
        <wa-badge variant="${restricted ? "warning" : "success"}" pill>${restricted ? "Restricted" : "Everyone"}</wa-badge>
      </td>
      <td>${edit}</td>
    </tr>
  `;
}

function renderEditRow(domain) {
  return `
    <tr class="domain-edit-row">
      <td colspan="5">
        <form class="wa-stack wa-gap-s">
          <div class="wa-cluster wa-gap-s wa-align-items-end">
            <wa-input name="rootRedirect" label="Root Redirect" placeholder="https://example.com" value="${escapeAttr(domain.rootRedirect)}" style="flex:1;min-width:200px;"></wa-input>
            <wa-input name="notFoundRedirect" label="404 Redirect" placeholder="https://example.com/404" value="${escapeAttr(domain.notFoundRedirect)}" style="flex:1;min-width:200px;"></wa-input>
            <wa-select name="accessMode" label="Access" value="${escapeAttr(domain.accessMode)}" style="min-width:140px;">
              <wa-option value="all">Everyone</wa-option>
              <wa-option value="restricted">Restricted</wa-option>
            </wa-select>
          </div>
          <wa-textarea name="accessEmails" label="Allowed Emails (one per line)" rows="3" placeholder="user@example.com" value="${escapeAttr((domain.accessEmails || []).join("\n"))}" ${domain.accessMode === "restricted" ? "" : "hidden"}></wa-textarea>
          <div class="wa-cluster wa-gap-s">
            <wa-button type="submit" variant="brand" size="s">Save</wa-button>
            <wa-button variant="neutral" size="s" class="cancel-edit-btn">Cancel</wa-button>
          </div>
        </form>
      </td>
    </tr>
  `;
}

const DOMAINS_PANEL = `
  <wa-tab-panel name="domains">
    <wa-card>
      <h3 slot="header">Configured Domains</h3>
      <wa-button slot="header-actions" id="sync-domains-btn" variant="brand" size="s">
        <wa-icon slot="start" name="arrows-rotate"></wa-icon>
        Sync from Cloudflare
      </wa-button>
      <div id="domains-list"></div>
    </wa-card>
  </wa-tab-panel>
`;

function bindDomains(container) {
  const list = container.querySelector("#domains-list");
  const syncBtn = container.querySelector("#sync-domains-btn");

  const loadDomains = () => loadTableSection(list, {
    url: "/api/domains",
    label: "Custom domains",
    headers: ["Hostname", "Root Redirect", "404 Redirect", "Access", "Actions"],
    renderRow: renderDomainRow,
    empty: `No domains configured. Click "Sync from Cloudflare" to import domains routed to this worker.`,
    error: "Failed to load domains.",
  });

  syncBtn.addEventListener("click", async () => {
    const synced = await withLoadingBtn(syncBtn, () => apiFetch("/api/domains/sync", { method: "POST" }));
    if (!synced) return;
    showToast("Domains synced from Cloudflare", "success");
    loadDomains();
  });

  function bindEditForm(form, hostname) {
    const path = `/api/domains/${encodeURIComponent(hostname)}`;
    const accessSelect = form.querySelector('[name="accessMode"]');
    const emailsInput = form.querySelector('[name="accessEmails"]');
    const submitBtn = form.querySelector('wa-button[type="submit"]');

    accessSelect.addEventListener("change", () => {
      emailsInput.hidden = accessSelect.value !== "restricted";
    });
    form.querySelector(".cancel-edit-btn").addEventListener("click", () => form.closest("tr").remove());

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fields = new FormData(form);
      // A wa-select with no selection submits no entry.
      const text = (name) => String(fields.get(name) ?? "").trim();
      const accessMode = text("accessMode");
      const configSaved = await withLoadingBtn(submitBtn, async () => {
        const configRes = await apiFetch(path, {
          method: "PUT",
          json: {
            rootRedirect: text("rootRedirect") || null,
            notFoundRedirect: text("notFoundRedirect") || null,
            accessMode,
          },
        });
        if (!configRes) return false;
        const emails = text("accessEmails").split("\n").map((s) => s.trim()).filter(Boolean);
        const accessSaved = accessMode !== "restricted"
          || await apiFetch(`${path}/access`, { method: "PUT", json: { emails } });
        // The config is saved either way; apiFetch has already toasted a failed access save.
        if (accessSaved) showToast("Domain updated", "success");
        return true;
      });
      if (configSaved) loadDomains();
    });
  }

  delegateClick(list, ".edit-domain-btn", async (btn) => {
    const hostname = btn.dataset.hostname;
    const detail = await withLoadingBtn(btn, () => apiFetch(`/api/domains/${encodeURIComponent(hostname)}`));
    if (!detail || !btn.isConnected) return;
    list.querySelectorAll(".domain-edit-row").forEach((r) => r.remove());
    const row = btn.closest("tr");
    row.insertAdjacentHTML("afterend", renderEditRow(detail.data));
    bindEditForm(row.nextElementSibling.querySelector("form"), hostname);
  });

  loadDomains();
}

/* ── View ─────────────────────────────────────────────────────────── */

/** Settings shell. Each tab's section loads, and reloads after a mutation, on its own. */
export function renderSettings(container, { user }) {
  const passkeyEnabled = isPasskeyEnabled();
  const { isAdmin } = user;

  container.innerHTML = `
    <div class="wa-stack wa-gap-l">
      <h1>Settings</h1>
      <wa-tab-group without-scroll-controls>
        <wa-tab panel="api-keys">API Keys</wa-tab>
        ${passkeyEnabled ? `<wa-tab panel="passkeys">Passkeys</wa-tab>` : ""}
        ${isAdmin ? `<wa-tab panel="domains">Domains</wa-tab>` : ""}
        ${apiKeysPanel()}
        ${passkeyEnabled ? PASSKEYS_PANEL : ""}
        ${isAdmin ? DOMAINS_PANEL : ""}
      </wa-tab-group>
      <wa-dialog id="delete-key-dialog" label="Delete API Key">
        <p>Are you sure you want to delete the key <strong id="delete-key-name"></strong>? This cannot be undone.</p>
        <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" variant="danger" id="confirm-delete-key">Delete</wa-button>
      </wa-dialog>
      ${passkeyEnabled ? `
        <wa-dialog id="delete-passkey-dialog" label="Delete Passkey">
          <p>Are you sure you want to delete the passkey <strong id="delete-passkey-name"></strong>? You won't be able to sign in with it anymore.</p>
          <wa-button slot="footer" variant="neutral" data-dialog="close">Cancel</wa-button>
          <wa-button slot="footer" variant="danger" id="confirm-delete-passkey">Delete</wa-button>
        </wa-dialog>
      ` : ""}
    </div>
  `;

  bindApiKeys(container);
  if (passkeyEnabled) bindPasskeys(container);
  if (isAdmin) bindDomains(container);
}
