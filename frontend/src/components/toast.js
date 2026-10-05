const VARIANT_ICONS = {
  success: "circle-check",
  danger: "circle-xmark",
  warning: "triangle-exclamation",
  brand: "circle-info",
};

let toast;
function getToast() {
  if (!toast) {
    toast = document.createElement("wa-toast");
    document.body.appendChild(toast);
  }
  return toast;
}

export function showToast(message, variant) {
  getToast().create(message, { variant, duration: 3000, icon: VARIANT_ICONS[variant] });
}

/**
 * Show a notice that stays until the user dismisses it (`duration: 0`).
 * `content` is trusted markup so the notice can carry links — never pass user
 * data through it. `showToast` remains the text-only path for everything else.
 */
export function showNotice(content, variant) {
  getToast().create(content, { variant, duration: 0, allowHtml: true, icon: VARIANT_ICONS[variant] });
}
