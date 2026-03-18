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
        <div class="wa-stack wa-gap-m" style="padding-top:0.5rem;">
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

    const submitBtn = form.querySelector('wa-button[type="submit"]');
    submitBtn.loading = true;
    submitBtn.disabled = true;

    const expiresAtVal = form.querySelector('[name="expiresAt"]').value;
    const passwordVal = passwordInput.value;

    const data = {
      ...(!isEdit && { slug: form.querySelector('[name="slug"]').value.trim() }),
      destinationUrl: form.querySelector('[name="destinationUrl"]').value.trim(),
      title: form.querySelector('[name="title"]').value.trim() || null,
      redirectType: Number(form.querySelector('[name="redirectType"]').value),
      expiresAt: expiresAtVal ? new Date(expiresAtVal).toISOString() : null,
      maxClicks: maxClicksVal ? Number(maxClicksVal) : null,
      isInternal: form.querySelector('[name="isInternal"]').checked,
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
