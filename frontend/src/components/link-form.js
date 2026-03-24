import { showToast } from "./toast.js";
import { navigate } from "../router.js";
import { escapeAttr } from "../lib/escape.js";

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
    <wa-input name="targetPriority" label="Priority" type="number" value="${escapeAttr(target.priority != null ? String(target.priority) : "0")}" style="max-width:80px;"></wa-input>
    <wa-button variant="danger" appearance="plain" circle class="remove-target-btn" aria-label="Remove rule">
      <wa-icon name="xmark"></wa-icon>
    </wa-button>
  `;
  row.querySelector(".remove-target-btn").addEventListener("click", () => row.remove());
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

export function renderLinkForm(container, { link = null, onSuccess } = {}) {
  const isEdit = !!link;
  const hasPassword = isEdit && link.hasPassword;
  container.innerHTML = `
    <form id="link-form" class="wa-stack wa-gap-m">
      <wa-input
        name="slug"
        label="Slug"
        placeholder="my-link"
        required
        value="${escapeAttr(link?.slug || "")}"
        hint="Letters, numbers, hyphens, underscores (1-128 chars)"
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
        <div class="wa-stack wa-gap-m" style="padding-top:var(--wa-space-xs);">
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
          <wa-input
            name="maxClicks"
            label="Max Clicks"
            type="number"
            min="1"
            value="${escapeAttr(link?.maxClicks != null ? String(link.maxClicks) : "")}"
            hint="Link will stop redirecting after this many clicks"
          ></wa-input>
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
              <wa-button size="small" variant="neutral" id="add-target-btn">
                <wa-icon slot="start" name="plus"></wa-icon>
                Add Rule
              </wa-button>
            </div>
            <p class="wa-body-s wa-color-text-quiet" style="margin:0;">Redirect visitors to different URLs based on country or device type.</p>
            <div id="targets-list" class="wa-stack wa-gap-s"></div>
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

  // Populate campaigns dropdown
  const campaignSelect = container.querySelector('[name="campaignIds"]');
  fetch("/api/campaigns")
    .then(res => res.ok ? res.json() : { data: [] })
    .then(({ data }) => {
      const selectedIds = new Set((link?.campaigns || []).map(c => c.id));
      for (const c of data) {
        const opt = document.createElement("wa-option");
        opt.value = c.id;
        opt.textContent = c.name;
        if (selectedIds.has(c.id)) opt.selected = true;
        campaignSelect.appendChild(opt);
      }
    })
    .catch(() => {}); // silently ignore

  // Populate domains dropdown
  const domainSelect = container.querySelector('[name="domainHostname"]');
  fetch("/api/domains")
    .then(res => res.ok ? res.json() : { data: [] })
    .then(({ data }) => {
      for (const d of data) {
        const opt = document.createElement("wa-option");
        opt.value = d.hostname;
        opt.textContent = d.hostname;
        domainSelect.appendChild(opt);
      }
      if (link?.domainHostname) {
        const match = domainSelect.querySelector(`wa-option[value="${CSS.escape(link.domainHostname)}"]`);
        if (match) match.selected = true;
      }
    })
    .catch(() => {});

  // Populate existing targeting rules
  const targetsList = container.querySelector("#targets-list");
  if (link?.targets && link.targets.length) {
    for (const t of link.targets) {
      targetsList.appendChild(createTargetRow(t));
    }
  }

  // Add target button
  container.querySelector("#add-target-btn").addEventListener("click", () => {
    targetsList.appendChild(createTargetRow());
  });

  // Track whether password field was touched
  let passwordTouched = false;
  const passwordInput = container.querySelector('[name="password"]');
  passwordInput.addEventListener("input", () => { passwordTouched = true; });

  container.querySelector("#link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const maxClicksInput = form.querySelector('[name="maxClicks"]');
    const maxClicksVal = maxClicksInput.value;
    if (maxClicksVal !== "" && (!Number.isInteger(Number(maxClicksVal)) || Number(maxClicksVal) < 1)) {
      showToast("Max clicks must be a positive integer", "danger");
      maxClicksInput.focus();
      return;
    }

    // Validate targeting rules
    const targets = collectTargets(container);
    const targetRows = container.querySelectorAll(".target-rule");
    for (const row of targetRows) {
      const match = row.querySelector('[name="targetMatch"]').value.trim();
      const url = row.querySelector('[name="targetUrl"]').value.trim();
      if ((match && !url) || (!match && url)) {
        showToast("Each targeting rule must have both a match value and destination URL", "danger");
        return;
      }
    }

    const submitBtn = form.querySelector('wa-button[type="submit"]');
    submitBtn.loading = true;
    submitBtn.disabled = true;

    const expiresAtVal = form.querySelector('[name="expiresAt"]').value;
    const passwordVal = passwordInput.value;
    const campaignIdsVal = form.querySelector('[name="campaignIds"]').value || [];
    const domainHostnameVal = form.querySelector('[name="domainHostname"]').value;

    const data = {
      ...(!isEdit && { slug: form.querySelector('[name="slug"]').value.trim() }),
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

    try {
      const url = isEdit ? `/api/links/${link.id}` : "/api/links";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) {
        showToast(result.message || result.error || "Error", "danger");
        return;
      }

      // Save targeting rules
      const linkId = result.data.id;
      if (targets.length > 0 || (isEdit && link?.targets?.length)) {
        try {
          const targetRes = await fetch(`/api/links/${linkId}/targets`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targets }),
          });
          if (!targetRes.ok) {
            showToast("Link saved, but targeting rules failed to save", "warning");
          }
        } catch {
          showToast("Link saved, but targeting rules failed to save", "warning");
        }
      }

      showToast(isEdit ? "Link updated" : "Link created", "success");
      if (onSuccess) onSuccess(result.data);
      else navigate(`/links/${result.data.id}`);
    } catch (err) {
      showToast("Network error", "danger");
    } finally {
      submitBtn.loading = false;
      submitBtn.disabled = false;
    }
  });
}
