import { showToast } from "./toast.js";
import { escapeAttr } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, setTeamOptions } from "../lib/ui.js";
import { normalizeSlug, MAX_SLUG_LENGTH } from "../../../src/services/slug.ts";
import { DEVICE_TYPES } from "../../../src/services/useragent.ts";

function toLocalDatetime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// New device rules start on mobile, the usual target, not on DEVICE_TYPES[0].
const DEFAULT_DEVICE = "mobile";

/** The match value of a rule row, read from whichever control its type shows. */
function targetMatchValue(row) {
  return row.querySelector('[name="targetType"]').value === "device"
    ? row.querySelector('[name="targetDevice"]').value
    : row.querySelector('[name="targetCountry"]').value.trim().toUpperCase();
}

/**
 * One targeting rule. Its constraints mirror the API's checks on the match value
 * and URL, so a rule the API would reject blocks the submit before the link is
 * saved. The match control a type hides is also disabled, because a hidden
 * enabled control still takes part in validation.
 */
function createTargetRow(target = {}) {
  const isGeo = target.type !== "device";
  const row = document.createElement("div");
  row.className = "target-rule wa-cluster wa-gap-s wa-align-items-end";
  row.innerHTML = `
    <wa-select name="targetType" label="Type" value="${isGeo ? "geo" : "device"}" style="min-width:120px;">
      <wa-option value="geo">Country</wa-option>
      <wa-option value="device">Device</wa-option>
    </wa-select>
    <wa-input name="targetCountry" label="Country" placeholder="US" maxlength="2" required pattern="[A-Za-z]{2}" hint="2-letter code" value="${escapeAttr(isGeo ? target.matchValue : "")}" style="min-width:120px;" ${isGeo ? "" : "hidden disabled"}></wa-input>
    <wa-select name="targetDevice" label="Device" value="${escapeAttr(isGeo ? DEFAULT_DEVICE : target.matchValue || DEFAULT_DEVICE)}" style="min-width:140px;" ${isGeo ? "hidden disabled" : ""}>
      ${DEVICE_TYPES.map((d) => `<wa-option value="${d}">${d[0].toUpperCase()}${d.slice(1)}</wa-option>`).join("")}
    </wa-select>
    <wa-input name="targetUrl" label="Destination" type="url" required pattern="https?://.+" placeholder="https://..." value="${escapeAttr(target.destinationUrl)}" style="flex:1;"></wa-input>
    <wa-number-input name="targetPriority" label="Priority" without-steppers value="${escapeAttr(target.priority != null ? String(target.priority) : "0")}" style="max-width:80px;"></wa-number-input>
    <wa-button variant="danger" appearance="plain" pill class="remove-target-btn">
      <wa-icon name="xmark" label="Remove rule"></wa-icon>
    </wa-button>
  `;
  const typeSelect = row.querySelector('[name="targetType"]');
  const countryInput = row.querySelector('[name="targetCountry"]');
  const deviceSelect = row.querySelector('[name="targetDevice"]');
  typeSelect.addEventListener("change", () => {
    const geo = typeSelect.value === "geo";
    countryInput.hidden = countryInput.disabled = !geo;
    deviceSelect.hidden = deviceSelect.disabled = geo;
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
    <wa-input name="abUrl" label="Variant URL" type="url" required pattern="https?://.+" placeholder="https://..." value="${escapeAttr(variant.destinationUrl)}" style="flex:1;"></wa-input>
    <wa-number-input name="abWeight" label="Weight %" without-steppers required min="1" max="99" value="${escapeAttr(variant.matchValue || "50")}" style="max-width:100px;"></wa-number-input>
    <wa-button variant="danger" appearance="plain" pill class="remove-ab-btn">
      <wa-icon name="xmark" label="Remove variant"></wa-icon>
    </wa-button>
  `;
  row.querySelector(".remove-ab-btn").addEventListener("click", () => row.remove());
  return row;
}

/** Targeting rules then A/B variants, in the shape PUT /api/links/:id/targets takes. */
function collectTargets(container) {
  const rules = [...container.querySelectorAll(".target-rule")].map((row) => ({
    type: row.querySelector('[name="targetType"]').value,
    matchValue: targetMatchValue(row),
    destinationUrl: row.querySelector('[name="targetUrl"]').value.trim(),
    priority: Number(row.querySelector('[name="targetPriority"]').value) || 0,
  }));
  const variants = [...container.querySelectorAll(".ab-variant")].map((row) => ({
    type: "ab",
    matchValue: row.querySelector('[name="abWeight"]').value.trim(),
    destinationUrl: row.querySelector('[name="abUrl"]').value.trim(),
    priority: 0,
  }));
  return [...rules, ...variants];
}

/** An order-free snapshot of a target list, normalized the way the API stores it, for change detection. */
function targetsKey(targets) {
  return targets.map((t) => JSON.stringify([
    t.type,
    t.type === "ab" ? String(parseInt(t.matchValue, 10)) : t.matchValue.toUpperCase(),
    t.destinationUrl,
    Math.trunc(Number(t.priority) || 0),
  ])).sort().join("\n");
}

/** An order-free snapshot of a list of ids, for change detection. */
function idsKey(ids) {
  return [...ids].sort().join(",");
}

/** Fill the campaign select, preselecting `selectedIds`. Resolves true once the options are in, false when the fetch failed. */
async function loadCampaignOptions(select, selectedIds) {
  const result = await apiFetch("/api/campaigns");
  if (!result) return false;
  for (const c of result.data) {
    const opt = document.createElement("wa-option");
    opt.value = c.id;
    opt.textContent = c.name;
    opt.selected = selectedIds.includes(c.id);
    select.append(opt);
  }
  return true;
}

/**
 * Fill the domain select with the custom domains this user may pick, plus
 * `current` when it is not among them, and select `current`. Resolves true once
 * the options are in, false when the fetch failed.
 */
async function loadDomainOptions(select, current) {
  const result = await apiFetch("/api/domains");
  if (!result) return false;
  // The primary host holds no links of its own: "Default domain" is it.
  const hostnames = result.data.filter((d) => !d.isPrimary).map((d) => d.hostname);
  if (current && !hostnames.includes(current)) hostnames.push(current);
  for (const hostname of hostnames) {
    const opt = document.createElement("wa-option");
    opt.value = hostname;
    opt.textContent = hostname;
    select.append(opt);
  }
  if (current) select.value = current;
  return true;
}

/**
 * Link create/edit form. `onSuccess` fires when everything saved; `onPartialSave`
 * fires when the link row was written but its targeting rules were rejected.
 */
function renderLinkForm(container, { link = null, onSuccess, onPartialSave, teams = [] } = {}) {
  const isEdit = !!link;
  const hasPassword = isEdit && link.hasPassword;
  const hasTeams = teams.length > 0;
  // Set as soon as the link row exists. A save that got the link in but not its
  // targeting rules leaves the form open, and the retry must update that row
  // rather than create a second link.
  let savedId = link?.id ?? null;
  // What the server holds for the fields an edit sends only when they change. A
  // select's entry stays null until its options load, and an edit never sends a
  // field whose entry is null, so a slow or failed options fetch cannot clear
  // the link's campaigns or move it to the default domain.
  const saved = {
    expiresAt: toLocalDatetime(link?.expiresAt),
    campaignIds: null,
    domainHostname: null,
    targets: targetsKey(link?.targets ?? []),
  };
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
        autocapitalize="none"
        spellcheck="false"
        value="${escapeAttr(link?.slug)}"
        hint="Case-insensitive. Letters, numbers, emoji and URL-safe punctuation (1-${MAX_SLUG_LENGTH} chars)"
        ${isEdit ? "disabled" : ""}
      ></wa-input>
      <wa-input
        name="destinationUrl"
        label="Destination URL"
        type="url"
        placeholder="https://example.com/long-page"
        required
        value="${escapeAttr(link?.destinationUrl)}"
      ></wa-input>
      <wa-input
        name="title"
        label="Title (optional)"
        placeholder="My awesome link"
        value="${escapeAttr(link?.title)}"
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
            value="${escapeAttr(saved.expiresAt)}"
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
            autocomplete="new-password"
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
            value="${escapeAttr(link?.ogTitle)}"
          ></wa-input>
          <wa-textarea
            name="ogDescription"
            label="OG Description"
            placeholder="Custom social preview description"
            rows="2"
            value="${escapeAttr(link?.ogDescription)}"
          ></wa-textarea>
          <wa-input
            name="ogImage"
            label="OG Image URL"
            type="url"
            placeholder="https://example.com/image.png"
            value="${escapeAttr(link?.ogImage)}"
          ></wa-input>
        </div>
      </wa-details>

      <wa-button type="submit" variant="brand">${isEdit ? "Update" : "Create"} Link</wa-button>
    </form>
  `;

  const form = container.querySelector("#link-form");
  const ownerSelect = form.querySelector('[name="teamId"]');
  if (ownerSelect) {
    setTeamOptions(ownerSelect, teams);
    ownerSelect.addEventListener("change", () => {
      ownerSelect.querySelector('wa-icon[slot="start"]').name = ownerSelect.value ? "people-group" : "user";
    });
  }

  const campaignSelect = form.querySelector('[name="campaignIds"]');
  loadCampaignOptions(campaignSelect, (link?.campaigns ?? []).map((c) => c.id)).then((ok) => {
    // Read from the options, which the select itself picks up only after its
    // slot change. Campaigns this user does not own are not options, so they
    // stay out of the baseline. Sending campaignIds still replaces every
    // association server-side, theirs included, so an edit sends it only on a
    // real change.
    if (ok) saved.campaignIds = idsKey([...campaignSelect.querySelectorAll("wa-option")].filter((o) => o.selected).map((o) => o.value));
  });

  const domainSelect = form.querySelector('[name="domainHostname"]');
  loadDomainOptions(domainSelect, link?.domainHostname ?? "").then((ok) => {
    if (ok) saved.domainHostname = link?.domainHostname ?? "";
  });

  const targetsList = form.querySelector("#targets-list");
  const abList = form.querySelector("#ab-list");
  for (const t of link?.targets ?? []) {
    if (t.type === "ab") abList.appendChild(createAbRow(t));
    else targetsList.appendChild(createTargetRow(t));
  }

  form.querySelector("#add-target-btn").addEventListener("click", () => {
    targetsList.appendChild(createTargetRow());
  });

  form.querySelector("#add-ab-btn").addEventListener("click", () => {
    abList.appendChild(createAbRow());
  });

  // Clearing a password is an explicit act, never inferred from an empty field.
  const passwordInput = form.querySelector('[name="password"]');
  const removePassword = form.querySelector('[name="removePassword"]');
  removePassword?.addEventListener("change", () => {
    passwordInput.disabled = removePassword.checked;
    if (removePassword.checked) passwordInput.value = "";
  });

  // Native validation cannot focus a control inside the collapsed <wa-details>,
  // so the submit silently fails. Catch `invalid` in the capture phase, since it
  // doesn't bubble: expand the section and toast once per submit.
  let invalidReported = false;
  form.addEventListener("invalid", (e) => {
    const field = e.target;
    const details = field.closest("wa-details");
    if (details) details.open = true;
    if (invalidReported) return;
    invalidReported = true;
    setTimeout(() => { invalidReported = false; }, 0);
    showToast(field.validationMessage || "Please correct the highlighted field", "danger");
    if (details) field.focus();
  }, true);

  // Reflect the canonical slug back into the field on commit, so the user sees
  // the lowercase form the API will actually store.
  const slugInput = form.querySelector('[name="slug"]');
  slugInput.addEventListener("change", () => {
    const normalized = normalizeSlug(slugInput.value);
    if (normalized !== slugInput.value) slugInput.value = normalized;
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const targets = collectTargets(form);
    const totalWeight = targets
      .filter((t) => t.type === "ab")
      .reduce((sum, t) => sum + (parseInt(t.matchValue, 10) || 0), 0);
    if (totalWeight >= 100) {
      showToast("A/B variant weights must sum to less than 100", "danger");
      return;
    }

    const submitBtn = form.querySelector('wa-button[type="submit"]');
    await withLoadingBtn(submitBtn, async () => {
      const editing = savedId !== null;
      // A disabled control is left out, which covers the slug once the link
      // exists and the password while "Remove password" is on.
      const fields = new FormData(form);
      const text = (name) => String(fields.get(name) ?? "").trim();
      const expiresAt = text("expiresAt");
      const maxClicks = text("maxClicks");
      const password = fields.get("password");
      // The selects are read through `value`: an array for the multiple
      // campaign select, and null once the domain is cleared.
      const campaignIds = campaignSelect.value ?? [];
      const domainHostname = domainSelect.value || "";

      const data = {
        ...(!editing && { slug: fields.get("slug") }),
        destinationUrl: text("destinationUrl"),
        title: text("title") || null,
        redirectType: Number(fields.get("redirectType")),
        maxClicks: maxClicks ? Number(maxClicks) : null,
        isInternal: fields.has("isInternal"),
        paramForwarding: fields.has("paramForwarding"),
        ogTitle: text("ogTitle") || null,
        ogDescription: text("ogDescription") || null,
        ogImage: text("ogImage") || null,
      };

      // An edit leaves out each of these when it is unchanged. Resending an
      // already-past expiry fails the API's "must be in the future" check,
      // which would block edits to anything else on an expired link.
      if (!editing || expiresAt !== saved.expiresAt) {
        data.expiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
      }
      if (!editing || (saved.campaignIds !== null && idsKey(campaignIds) !== saved.campaignIds)) {
        data.campaignIds = campaignIds;
      }
      if (!editing || (saved.domainHostname !== null && domainHostname !== saved.domainHostname)) {
        data.domainHostname = domainHostname || null;
      }

      if (!editing && ownerSelect?.value) data.teamId = ownerSelect.value;

      if (removePassword?.checked) data.password = null;
      else if (password) data.password = password;

      const url = editing ? `/api/links/${savedId}` : "/api/links";
      const method = editing ? "PUT" : "POST";
      const result = await apiFetch(url, { method, json: data });
      if (!result) return;

      savedId = result.data.id;
      saved.expiresAt = expiresAt;
      if ("campaignIds" in data) saved.campaignIds = idsKey(campaignIds);
      if ("domainHostname" in data) saved.domainHostname = domainHostname;
      if (!editing) {
        // Slug and owner are fixed once the row exists.
        slugInput.disabled = true;
        if (ownerSelect) ownerSelect.disabled = true;
      }

      const targetsSnapshot = targetsKey(targets);
      if (targetsSnapshot !== saved.targets) {
        const targetRes = await apiFetch(`/api/links/${savedId}/targets`, { method: "PUT", json: { targets } });
        if (!targetRes) {
          // The link itself is saved. Keep the form and its rules on screen so
          // the rules can be corrected and submitted again.
          showToast("Link saved, but its targeting rules were not. Correct them and save again.", "warning");
          onPartialSave();
          return;
        }
        saved.targets = targetsSnapshot;
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
        // The full save supersedes any earlier partial one, so the close below
        // must not refresh a second time.
        partialSave = false;
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
