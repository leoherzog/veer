import { showToast } from "./toast.js";
import { navigate } from "../router.js";
import { escapeAttr } from "../lib/escape.js";
import { apiFetch, withLoadingBtn, setTeamOptions } from "../lib/ui.js";
import { normalizeSlug } from "../lib/slug.js";

function toLocalDatetime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function createTargetRow(target = {}) {
  const row = document.createElement("div");
  row.className = "target-rule wa-cluster wa-gap-s wa-align-items-end";
  row.innerHTML = `
    <wa-select name="targetType" label="Type" style="min-width:120px;">
      <wa-option value="geo" ${(target.type || "geo") === "geo" ? "selected" : ""}>Country</wa-option>
      <wa-option value="device" ${target.type === "device" ? "selected" : ""}>Device</wa-option>
    </wa-select>
    <wa-input name="targetMatch" label="Match" placeholder="US" hint="Country code or device type" value="${escapeAttr(target.matchValue || "")}" style="min-width:120px;"></wa-input>
    <wa-input name="targetUrl" label="Destination" type="url" placeholder="https://..." value="${escapeAttr(target.destinationUrl || "")}" style="flex:1;"></wa-input>
    <wa-number-input name="targetPriority" label="Priority" without-steppers value="${escapeAttr(target.priority != null ? String(target.priority) : "0")}" style="max-width:80px;"></wa-number-input>
    <wa-button variant="danger" appearance="plain" pill class="remove-target-btn" aria-label="Remove rule">
      <wa-icon name="xmark"></wa-icon>
    </wa-button>
  `;
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

function collectTargets(container) {
  const rows = container.querySelectorAll(".target-rule");
  const targets = [];
  for (const row of rows) {
    const type = row.querySelector('[name="targetType"]').value;
    const match = row.querySelector('[name="targetMatch"]').value.trim();
    const url = row.querySelector('[name="targetUrl"]').value.trim();
    const priority = Number(row.querySelector('[name="targetPriority"]').value) || 0;
    if (match && url) {
      targets.push({ type, matchValue: match, destinationUrl: url, priority });
    }
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

export function renderLinkForm(container, { link = null, onSuccess, teams = [] } = {}) {
  const isEdit = !!link;
  const hasPassword = isEdit && link.hasPassword;
  const hasTeams = teams.length > 0;
  const currentTeamId = link?.teamId || "";
  container.innerHTML = `
    <form id="link-form" class="wa-stack wa-gap-m">
      ${hasTeams ? `
        <wa-select name="teamId" label="Owner" ${isEdit ? "disabled" : ""}>
          <wa-icon slot="start" name="${currentTeamId ? "people-group" : "user"}" class="wa-font-size-s"></wa-icon>
          <wa-option value="" ${!currentTeamId ? "selected" : ""}>Me</wa-option>
        </wa-select>
      ` : ""}
      <wa-input
        name="slug"
        label="Slug"
        placeholder="my-link"
        required
        value="${escapeAttr(link?.slug || "")}"
        hint="Case-insensitive. Letters, numbers, emoji and URL-safe punctuation (1-128 chars)"
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
            value="${escapeAttr(toLocalDatetime(link?.expiresAt))}"
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
            hint="${hasPassword ? "Leave empty to keep current password" : "Visitors must enter this password to access the link"}"
          ></wa-input>
          <wa-switch name="isInternal" ${link?.isInternal ? "checked" : ""}>Internal link (hidden from public listings)</wa-switch>
          <wa-divider></wa-divider>
          <wa-switch name="paramForwarding" ${link ? (link.paramForwarding ? "checked" : "") : "checked"}>Forward query parameters to destination</wa-switch>
          <wa-divider></wa-divider>
          <wa-select name="campaignIds" label="Campaigns (optional)" multiple with-clear max-options-visible="3">
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
            <p class="wa-body-s wa-color-text-quiet" style="margin:0;">Redirect visitors to different URLs based on country or device type.</p>
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
            <p class="wa-body-s wa-color-text-quiet" style="margin:0;">Split traffic between destination URLs. Weights must sum to less than 100 (remainder goes to default).</p>
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

  // Populate the owner select and keep its icon in sync with the selection
  const ownerSelect = container.querySelector('[name="teamId"]');
  if (ownerSelect) {
    setTeamOptions(ownerSelect, teams, { selected: currentTeamId });
    ownerSelect.addEventListener("change", () => {
      const icon = ownerSelect.querySelector('wa-icon[slot="start"]');
      if (icon) icon.name = ownerSelect.value ? "people-group" : "user";
    });
  }

  // Populate campaigns dropdown
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
  }).catch(() => {});

  // Populate domains dropdown
  const domainSelect = container.querySelector('[name="domainHostname"]');
  apiFetch("/api/domains").then(result => {
    if (!result) return;
    const { data } = result;
    for (const d of data) {
      const opt = document.createElement("wa-option");
      opt.value = d.hostname;
      opt.textContent = d.hostname;
      domainSelect.appendChild(opt);
    }
    if (link?.domainHostname) domainSelect.value = link.domainHostname;
  }).catch(() => {});

  // Populate existing targeting rules
  const targetsList = container.querySelector("#targets-list");
  for (const t of (link?.targets || []).filter(t => t.type !== "ab")) {
    targetsList.appendChild(createTargetRow(t));
  }

  // Add target button
  container.querySelector("#add-target-btn").addEventListener("click", () => {
    targetsList.appendChild(createTargetRow());
  });

  // Populate existing A/B variants
  const abList = container.querySelector("#ab-list");
  if (link?.targets) {
    for (const t of link.targets.filter(t => t.type === "ab")) {
      abList.appendChild(createAbRow(t));
    }
  }

  // Add A/B variant button
  container.querySelector("#add-ab-btn").addEventListener("click", () => {
    abList.appendChild(createAbRow());
  });

  // Track whether password field was touched
  let passwordTouched = false;
  const passwordInput = container.querySelector('[name="password"]');
  passwordInput.addEventListener("input", () => { passwordTouched = true; });

  // Several constrained fields (Max Clicks' `min="1"`, etc.) live inside the
  // collapsed "Advanced Options" <wa-details>. Native interactive validation
  // refuses to submit but can't focus or anchor its bubble on a control that
  // isn't rendered, so the user just sees the button do nothing. Catch the
  // `invalid` event (fired on the form-associated host, capture phase since it
  // doesn't bubble), expand the section holding the field, and name the problem
  // in a toast — one per submit attempt, not one per invalid control.
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

    // Validate targeting rules
    const targets = [...collectTargets(container), ...collectAbVariants(container)];
    const targetRows = container.querySelectorAll(".target-rule");
    for (const row of targetRows) {
      const match = row.querySelector('[name="targetMatch"]').value.trim();
      const url = row.querySelector('[name="targetUrl"]').value.trim();
      if ((match && !url) || (!match && url)) {
        showToast("Each targeting rule must have both a match value and destination URL", "danger");
        return;
      }
    }

    // Validate A/B weights
    const abVariants = collectAbVariants(container);
    const totalWeight = abVariants.reduce((sum, v) => sum + (parseInt(v.matchValue) || 0), 0);
    if (totalWeight >= 100) {
      showToast("A/B variant weights must sum to less than 100", "danger");
      return;
    }

    const submitBtn = form.querySelector('wa-button[type="submit"]');
    await withLoadingBtn(submitBtn, async () => {
      const expiresAtVal = form.querySelector('[name="expiresAt"]').value;
      const maxClicksVal = form.querySelector('[name="maxClicks"]').value;
      const passwordVal = passwordInput.value;
      const campaignIdsVal = form.querySelector('[name="campaignIds"]').value || [];
      const domainHostnameVal = form.querySelector('[name="domainHostname"]').value;

      const data = {
        ...(!isEdit && { slug: normalizeSlug(form.querySelector('[name="slug"]').value) }),
        destinationUrl: form.querySelector('[name="destinationUrl"]').value.trim(),
        title: form.querySelector('[name="title"]').value.trim() || null,
        redirectType: Number(form.querySelector('[name="redirectType"]').value),
        expiresAt: expiresAtVal ? new Date(expiresAtVal).toISOString() : null,
        maxClicks: maxClicksVal ? Number(maxClicksVal) : null,
        isInternal: form.querySelector('[name="isInternal"]').checked,
        paramForwarding: form.querySelector('[name="paramForwarding"]').checked,
        campaignIds: Array.isArray(campaignIdsVal) ? campaignIdsVal : campaignIdsVal ? [campaignIdsVal] : [],
        domainHostname: domainHostnameVal || null,
        ogTitle: form.querySelector('[name="ogTitle"]').value.trim() || null,
        ogDescription: form.querySelector('[name="ogDescription"]').value.trim() || null,
        ogImage: form.querySelector('[name="ogImage"]').value.trim() || null,
      };

      // Include teamId on create if an owner select exists and a team is selected
      if (!isEdit) {
        const teamIdVal = form.querySelector('[name="teamId"]')?.value;
        if (teamIdVal) data.teamId = teamIdVal;
      }

      // Only send password if touched (or on create if non-empty)
      if (isEdit) {
        if (passwordTouched) {
          data.password = passwordVal || null;
        }
      } else {
        if (passwordVal) {
          data.password = passwordVal;
        }
      }

      const url = isEdit ? `/api/links/${link.id}` : "/api/links";
      const method = isEdit ? "PUT" : "POST";
      const result = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!result) return;

      // Save targeting rules
      const linkId = result.data.id;
      if (targets.length > 0 || (isEdit && link?.targets?.length)) {
        const targetRes = await apiFetch(`/api/links/${linkId}/targets`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets }),
        });
        if (!targetRes) {
          showToast("Link saved, but targeting rules failed to save", "warning");
        }
      }

      showToast(isEdit ? "Link updated" : "Link created", "success");
      if (onSuccess) onSuccess(result.data);
      else navigate(`/links/${result.data.id}`);
    });
  });
}
