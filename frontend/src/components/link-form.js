import { showToast } from "./toast.js";
import { navigate } from "../router.js";
import { escapeAttr } from "../lib/escape.js";

export function renderLinkForm(container, { link = null, onSuccess } = {}) {
  const isEdit = !!link;
  container.innerHTML = `
    <form id="link-form" class="link-form">
      <wa-input
        name="slug"
        label="Slug"
        placeholder="my-link"
        required
        value="${escapeAttr(link?.slug || "")}"
        help-text="Letters, numbers, hyphens, underscores (1-128 chars)"
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
      <wa-radio-group label="Redirect Type" name="redirectType" value="${link?.redirectType || 302}">
        <wa-radio value="302">302 Temporary</wa-radio>
        <wa-radio value="301">301 Permanent</wa-radio>
      </wa-radio-group>
      <wa-button type="submit" variant="brand">${isEdit ? "Update" : "Create"} Link</wa-button>
    </form>
  `;

  container.querySelector("#link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('wa-button[type="submit"]');
    submitBtn.loading = true;
    submitBtn.disabled = true;

    const data = {
      slug: form.querySelector('[name="slug"]').value.trim(),
      destinationUrl: form.querySelector('[name="destinationUrl"]').value.trim(),
      title: form.querySelector('[name="title"]').value.trim() || undefined,
      redirectType: Number(form.querySelector('[name="redirectType"]').value),
    };

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
