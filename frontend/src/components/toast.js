const VARIANT_ICONS = {
  success: "circle-check",
  danger: "circle-xmark",
  warning: "triangle-exclamation",
  brand: "circle-info",
  neutral: "circle-info",
};

let toast;
function getToast() {
  if (!toast) {
    toast = document.createElement("wa-toast");
    document.body.appendChild(toast);
  }
  return toast;
}

export function showToast(message, variant = "neutral", duration = 3000) {
  getToast().create(message, {
    variant,
    duration,
    icon: VARIANT_ICONS[variant] || VARIANT_ICONS.neutral,
  });
}

/**
 * Show a notice that stays until the user dismisses it (`duration="0"`).
 * `content` is trusted markup so the notice can carry links — never pass user
 * data through it. `showToast` remains the text-only path for everything else.
 */
export function showNotice(content, variant = "neutral") {
  const item = document.createElement("wa-toast-item");
  item.variant = variant;
  item.duration = 0;
  item.innerHTML = `<wa-icon slot="icon" name="${VARIANT_ICONS[variant] || VARIANT_ICONS.neutral}"></wa-icon>${content}`;
  getToast().append(item);
  return item;
}
