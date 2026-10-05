import { showToast } from "./toast.js";
import { escapeAttr } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, setTeamOptions } from "../lib/ui.js";
import { normalizeSlug, MAX_SLUG_LENGTH } from "../../../src/services/slug.ts";

function toLocalDatetime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DEVICE_TYPES = ["mobile", "tablet", "desktop"];

/** The match value of a rule row, read from whichever control its type shows. */
function targetMatchValue(row) {
  return row.querySelector('[name="targetType"]').value === "device"
    ? row.querySelector('[name="targetDevice"]').value
    : row.querySelector('[name="targetCountry"]').value.trim().toUpperCase();
}

/**
 * One targeting rule. The match control is constrained to what the API accepts
 * — a 2-letter ISO country code or one of the known device types — so a rule
 * cannot fail server validation after the link itself has been saved.
 */
function createTargetRow(target = {}) {
  const type = target.type === "device" ? "device" : "geo";
  const row = document.createElement("div");
  row.className = "target-rule wa-cluster wa-gap-s wa-align-items-end";
  row.innerHTML = `
    <wa-select name="targetType" label="Type" value="${type}" style="min-width:120px;">
      <wa-option value="geo">Country</wa-option>
      <wa-option value="device">Device</wa-option>
    </wa-select>
    <wa-input name="targetCountry" label="Country" placeholder="US" maxlength="2" hint="2-letter code" value="${escapeAttr(type === "geo" ? target.matchValue || "" : "")}" style="min-width:120px;" ${type === "geo" ? "" : "hidden"}></wa-input>
    <wa-select name="targetDevice" label="Device" value="${escapeAttr(type === "device" ? target.matchValue || DEVICE_TYPES[0] : DEVICE_TYPES[0])}" style="min-width:140px;" ${type === "device" ? "" : "hidden"}>
      ${DEVICE_TYPES.map((d) => `<wa-option value="${d}">${d[0].toUpperCase()}${d.slice(1)}</wa-option>`).join("")}
    </wa-select>
    <wa-input name="targetUrl" label="Destination" type="url" placeholder="https://..." value="${escapeAttr(target.destinationUrl || "")}" style="flex:1;"></wa-input>
    <wa-number-input name="targetPriority" label="Priority" without-steppers value="${escapeAttr(target.priority != null ? String(target.priority) : "0")}" style="max-width:80px;"></wa-number-input>
    <wa-button variant="danger" appearance="plain" pill class="remove-target-btn" aria-label="Remove rule">
      <wa-icon name="xmark"></wa-icon>
    </wa-button>
  `;
  const typeSelect = row.querySelector('[name="targetType"]');
  const countryInput = row.querySelector('[name="targetCountry"]');
  const deviceSelect = row.querySelector('[name="targetDevice"]');
  typeSelect.addEventListener("change", () => {
    const isGeo = typeSelect.value === "geo";
    countryInput.hidden = !isGeo;
    deviceSelect.hidden = isGeo;
  });
  countryInput.addEventListener("input", () => {
    const upper = countryInput.value.toUpperCase();
    if (upper !== countryInput.value) countryInput.value = upper;
  });
  row.querySelector(".remove-target-btn").addEventListener("click", () => row.remove());
  return row;
}

function createAbRow(variant = {}) {
  const row = document.createElement("div");
  row.className = "ab-variant wa-cluster wa-gap-s wa-align-items-end";
  row.innerHTML = `
    <wa-input name="abUrl" label="Variant URL" type="url" placeholder="https://..." value="${escapeAttr(variant.destinationUrl || "")}" style="flex:1;"></wa-input>
    <wa-number-input name="abWeight" label="Weight %" without-steppers min="1" max="99" value="${escapeAttr(variant.matchValue || "50")}" style="max-width:100px;"></wa-number-input>
    <wa-button variant="danger" appearance="plain" pill class="remove-ab-btn" aria-label="Remove variant">
      <wa-icon name="xmark"></wa-icon>
    </wa-button>
  `;
  row.querySelector(".remove-ab-btn").addEventListener("click", () => row.remove());
  return row;
}

/** Filled targeting rules, or null when a row has only one of match value and URL. Empty rows are skipped. */
function collectTargets(container) {
  const rows = container.querySelectorAll(".target-rule");
  const targets = [];
  for (const row of rows) {
    const type = row.querySelector('[name="targetType"]').value;
    const match = targetMatchValue(row);
    const url = row.querySelector('[name="targetUrl"]').value.trim();
    const priority = Number(row.querySelector('[name="targetPriority"]').value) || 0;
    if (!match && !url) continue;
    if (!match || !url) return null;
    targets.push({ type, matchValue: match, destinationUrl: url, priority });
  }
  return targets;
}

function collectAbVariants(container) {
  const rows = container.querySelectorAll(".ab-variant");
  const variants = [];
  for (const row of rows) {
    const url = row.querySelector('[name="abUrl"]').value.trim();
    const weight = row.querySelector('[name="abWeight"]').value.trim();
    if (url && weight) {
      variants.push({ type: "ab", matchValue: weight, destinationUrl: url, priority: 0 });
    }
  }
  return variants;
}

/**
 * Link create/edit form. `onSuccess` fires when everything saved; `onPartialSave`
 * fires when the link row was written but its targeting rules were rejected.
 */
function renderLinkForm(container, { link = null, onSuccess, onPartialSave, teams = [] } = {}) {
  const isEdit = !!link;
  const hasPassword = isEdit && link.hasPassword;
  const hasTeams = teams.length > 0;
  const loadedExpiresAt = toLocalDatetime(link?.expiresAt);
  // Set as soon as the link row exists. A save that got the link in but not its
  // targeting rules leaves the form open, and the retry must update that row
  // rather than create a second link.
  let savedId = link?.id ?? null;
  let mustSaveTargets = !!link?.targets?.length;
  container.innerHTML = `
    <form id="link-form" class="wa-stack wa-gap-m">
      ${hasTeams ? `
        <wa-select name="teamId" label="Owner">
          <wa-icon slot="start" name="user" class="wa-font-size-s"></wa-icon>
          <wa-option value="" selected>Me</wa-option>
        </wa-select>
      ` : ""}
      <wa-input
        name="slug"
        label="Slug"
        placeholder="my-link"
        required
        value="${escapeAttr(link?.slug || "")}"
        hint="Case-insensitive. Letters, numbers, emoji and URL-safe punctuation (1-${MAX_SLUG_LENGTH} chars)"
        ${isEdit ? "disabled" : ""}
      ></wa-input>
      <wa-input
        name="destinationUrl"
        label="Destination URL"
        type="url"
        placeholder="https://example.com/long-page"
        required
        value="${escapeAttr(link?.destinationUrl || "")}"
      ></wa-input>
      <wa-input
        name="title"
        label="Title (optional)"
        placeholder="My awesome link"
        value="${escapeAttr(link?.title || "")}"
      ></wa-input>
      <wa-details summary="Advanced Options">
        <div class="wa-stack wa-gap-m">
          <wa-radio-group label="Redirect Type" name="redirectType" value="${link?.redirectType || 302}" orientation="horizontal">
            <wa-radio value="302">302 Temporary</wa-radio>
            <wa-radio value="301">301 Permanent</wa-radio>
          </wa-radio-group>
          <wa-input
            name="expiresAt"
            label="Expiration Date"
            type="datetime-local"
            value="${escapeAttr(loadedExpiresAt)}"
            hint="Link will stop redirecting after this date"
          ></wa-input>
          <wa-number-input
            name="maxClicks"
            label="Max Clicks"
            min="1"
            value="${escapeAttr(link?.maxClicks != null ? String(link.maxClicks) : "")}"
            hint="Link will stop redirecting after this many clicks"
          ></wa-number-input>
          <wa-input
            name="password"
            label="Password Protection"
            type="password"
            password-toggle
            value=""
            hint="${hasPassword ? "Leave empty to keep the current password" : "Visitors must enter this password to access the link"}"
          ></wa-input>
          ${hasPassword ? `<wa-switch name="removePassword" hint="Drops the password when you save">Remove password</wa-switch>` : ""}
          <wa-switch name="isInternal" ${link?.isInternal ? "checked" : ""} hint="Only signed-in users can follow it. Default domain only.">Internal link</wa-switch>
          <wa-divider></wa-divider>
          <wa-switch name="paramForwarding" ${link ? (link.paramForwarding ? "checked" : "") : "checked"}>Forward query parameters to destination</wa-switch>
          <wa-divider></wa-divider>
          <wa-select name="campaignIds" label="Campaigns (optional)" multiple with-clear>
          </wa-select>
          <wa-select name="domainHostname" label="Domain (optional)" with-clear>
            <wa-option value="" selected>Default domain</wa-option>
          </wa-select>
          <wa-divider></wa-divider>
          <div class="wa-stack wa-gap-s">
            <div class="wa-split">
              <strong>Targeting Rules</strong>
              <wa-button size="s" variant="neutral" id="add-target-btn">
                <wa-icon slot="start" name="plus"></wa-icon>
                Add Rule
              </wa-button>
            </div>
            <p class="wa-body-s wa-color-text-quiet">Redirect visitors to different URLs based on country or device type.</p>
            <div id="targets-list" class="wa-stack wa-gap-s"></div>
          </div>
          <wa-divider></wa-divider>
          <div class="wa-stack wa-gap-s">
            <div class="wa-split">
              <strong>A/B Test Variants</strong>
              <wa-button size="s" variant="neutral" id="add-ab-btn">
                <wa-icon slot="start" name="plus"></wa-icon>
                Add Variant
              </wa-button>
            </div>
            <p class="wa-body-s wa-color-text-quiet">Split traffic between destination URLs. Weights must sum to less than 100 (remainder goes to default).</p>
            <div id="ab-list" class="wa-stack wa-gap-s"></div>
          </div>
          <wa-divider></wa-divider>
          <wa-input
            name="ogTitle"
            label="OG Title"
            placeholder="Custom social preview title"
            value="${escapeAttr(link?.ogTitle || "")}"
          ></wa-input>
          <wa-textarea
            name="ogDescription"
            label="OG Description"
            placeholder="Custom social preview description"
            rows="2"
            value="${escapeAttr(link?.ogDescription || "")}"
          ></wa-textarea>
          <wa-input
            name="ogImage"
            label="OG Image URL"
            type="url"
            placeholder="https://example.com/image.png"
            value="${escapeAttr(link?.ogImage || "")}"
          ></wa-input>
        </div>
      </wa-details>

      <wa-button type="submit" variant="brand">${isEdit ? "Update" : "Create"} Link</wa-button>
    </form>
  `;

  const ownerSelect = container.querySelector('[name="teamId"]');
  if (ownerSelect) {
    setTeamOptions(ownerSelect, teams);
    ownerSelect.addEventListener("change", () => {
      const icon = ownerSelect.querySelector('wa-icon[slot="start"]');
      if (icon) icon.name = ownerSelect.value ? "people-group" : "user";
    });
  }

  const campaignSelect = container.querySelector('[name="campaignIds"]');
  apiFetch("/api/campaigns").then(result => {
    if (!result) return;
    const { data } = result;
    const selectedIds = new Set((link?.campaigns || []).map(c => c.id));
    for (const c of data) {
      const opt = document.createElement("wa-option");
      opt.value = c.id;
      opt.textContent = c.name;
      if (selectedIds.has(c.id)) opt.selected = true;
      campaignSelect.appendChild(opt);
    }
  });

  const domainSelect = container.querySelector('[name="domainHostname"]');
  apiFetch("/api/domains").then(result => {
    if (!result) return;
    const { data } = result;
    // The primary host holds no links of its own — "Default domain" is it.
    for (const d of data.filter((d) => !d.isPrimary)) {
      const opt = document.createElement("wa-option");
      opt.value = d.hostname;
      opt.textContent = d.hostname;
      domainSelect.appendChild(opt);
    }
    if (link?.domainHostname) domainSelect.value = link.domainHostname;
  });

  const targetsList = container.querySelector("#targets-list");
  const abList = container.querySelector("#ab-list");
  for (const t of link?.targets ?? []) {
    if (t.type === "ab") abList.appendChild(createAbRow(t));
    else targetsList.appendChild(createTargetRow(t));
  }

  container.querySelector("#add-target-btn").addEventListener("click", () => {
    targetsList.appendChild(createTargetRow());
  });

  container.querySelector("#add-ab-btn").addEventListener("click", () => {
    abList.appendChild(createAbRow());
  });

  // Clearing a password is an explicit act, never inferred from an empty field.
  const passwordInput = container.querySelector('[name="password"]');
  const removePassword = container.querySelector('[name="removePassword"]');
  removePassword?.addEventListener("change", () => {
    passwordInput.disabled = removePassword.checked;
    if (removePassword.checked) passwordInput.value = "";
  });

  // Native validation cannot focus a control inside the collapsed <wa-details>,
  // so the submit silently fails. Catch `invalid` in the capture phase, since it
  // doesn't bubble: expand the section and toast once per submit.
  let invalidReported = false;
  container.querySelector("#link-form").addEventListener("invalid", (e) => {
    const field = e.target;
    const details = field.closest?.("wa-details");
    if (details) details.open = true;
    if (invalidReported) return;
    invalidReported = true;
    setTimeout(() => { invalidReported = false; }, 0);
    showToast(field.validationMessage || "Please correct the highlighted field", "danger");
    if (details) field.focus?.();
  }, true);

  // Reflect the canonical slug back into the field on commit, so the user sees
  // the lowercase form the API will actually store.
  const slugInput = container.querySelector('[name="slug"]');
  slugInput?.addEventListener("change", () => {
    const normalized = normalizeSlug(slugInput.value);
    if (normalized !== slugInput.value) slugInput.value = normalized;
  });

  container.querySelector("#link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const rules = collectTargets(container);
    if (!rules) {
      showToast("Each targeting rule must have both a match value and destination URL", "danger");
      return;
    }

    const abVariants = collectAbVariants(container);
    const totalWeight = abVariants.reduce((sum, v) => sum + (parseInt(v.matchValue) || 0), 0);
    if (totalWeight >= 100) {
      showToast("A/B variant weights must sum to less than 100", "danger");
      return;
    }
    const targets = [...rules, ...abVariants];

    const submitBtn = form.querySelector('wa-button[type="submit"]');
    await withLoadingBtn(submitBtn, async () => {
      const editing = savedId !== null;
      const expiresAtVal = form.querySelector('[name="expiresAt"]').value;
      const maxClicksVal = form.querySelector('[name="maxClicks"]').value;
      const passwordVal = passwordInput.value;
      const domainHostnameVal = form.querySelector('[name="domainHostname"]').value;

      const data = {
        ...(!editing && { slug: slugInput.value }),
        destinationUrl: form.querySelector('[name="destinationUrl"]').value.trim(),
        title: form.querySelector('[name="title"]').value.trim() || null,
        redirectType: Number(form.querySelector('[name="redirectType"]').value),
        maxClicks: maxClicksVal ? Number(maxClicksVal) : null,
        isInternal: form.querySelector('[name="isInternal"]').checked,
        paramForwarding: form.querySelector('[name="paramForwarding"]').checked,
        campaignIds: form.querySelector('[name="campaignIds"]').value ?? [],
        domainHostname: domainHostnameVal || null,
        ogTitle: form.querySelector('[name="ogTitle"]').value.trim() || null,
        ogDescription: form.querySelector('[name="ogDescription"]').value.trim() || null,
        ogImage: form.querySelector('[name="ogImage"]').value.trim() || null,
      };

      // An unchanged expiry is left out entirely: resending an already-past date
      // fails the API's "must be in the future" check, which would block edits
      // to anything else on an expired link.
      if (!editing || expiresAtVal !== loadedExpiresAt) {
        data.expiresAt = expiresAtVal ? new Date(expiresAtVal).toISOString() : null;
      }

      if (!editing) {
        const teamIdVal = form.querySelector('[name="teamId"]')?.value;
        if (teamIdVal) data.teamId = teamIdVal;
      }

      if (removePassword?.checked) data.password = null;
      else if (passwordVal) data.password = passwordVal;

      const url = editing ? `/api/links/${savedId}` : "/api/links";
      const method = editing ? "PUT" : "POST";
      const result = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!result) return;

      savedId = result.data.id;
      if (!editing) {
        // Slug and owner are fixed once the row exists.
        slugInput.disabled = true;
        const ownerSel = form.querySelector('[name="teamId"]');
        if (ownerSel) ownerSel.disabled = true;
      }

      if (targets.length > 0 || mustSaveTargets) {
        const targetRes = await apiFetch(`/api/links/${savedId}/targets`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets }),
        });
        if (!targetRes) {
          // The link itself is saved. Keep the form and its rules on screen so
          // the rules can be corrected and submitted again.
          mustSaveTargets = true;
          showToast("Link saved, but its targeting rules were not. Correct them and save again.", "warning");
          onPartialSave();
          return;
        }
        mustSaveTargets = targets.length > 0;
      }

      showToast(isEdit ? "Link updated" : "Link created", "success");
      onSuccess();
    });
  });
}

/**
 * Render the link form into `dialog` each time it opens. `onSaved` runs after a
 * full save, or once the dialog closes after a partial one.
 */
export function bindLinkFormDialog(dialog, getOptions, onSaved) {
  // A partial save keeps the dialog open over stale data, so the refresh waits
  // for the user to close it.
  let partialSave = false;
  dialog.addEventListener("wa-show", (e) => {
    if (e.target !== dialog) return;
    renderLinkForm(dialog, {
      ...getOptions(),
      onSuccess: () => {
        dialog.open = false;
        onSaved();
      },
      onPartialSave: () => { partialSave = true; },
    });
  });
  dialog.addEventListener("wa-after-hide", (e) => {
    if (e.target !== dialog || !partialSave) return;
    partialSave = false;
    onSaved();
  });
}
