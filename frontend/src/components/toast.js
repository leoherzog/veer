let container;
function getContainer() {
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

const VARIANT_ICONS = {
  success: "circle-check",
  danger: "circle-xmark",
  warning: "triangle-exclamation",
  neutral: "circle-info",
};

export function showToast(message, variant = "neutral", duration = 3000) {
  const callout = document.createElement("wa-callout");
  callout.variant = variant;
  
  // Custom dismiss layout
  callout.style.position = "relative";
  callout.style.paddingRight = "2.5rem";

  const iconName = VARIANT_ICONS[variant] || VARIANT_ICONS.neutral;
  const icon = document.createElement("wa-icon");
  icon.setAttribute("slot", "icon");
  icon.setAttribute("name", iconName);
  callout.appendChild(icon);

  callout.appendChild(document.createTextNode(message));

  const closeBtn = document.createElement("wa-button");
  closeBtn.setAttribute("variant", "neutral");
  closeBtn.setAttribute("appearance", "plain");
  closeBtn.setAttribute("size", "small");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = `<wa-icon name="xmark"></wa-icon>`;
  closeBtn.style.position = "absolute";
  closeBtn.style.right = "0.25rem";
  closeBtn.style.top = "50%";
  closeBtn.style.transform = "translateY(-50%)";
  closeBtn.addEventListener("click", () => {
    clearTimeout(timer);
    if (callout.parentNode) callout.remove();
  });
  callout.appendChild(closeBtn);

  getContainer().appendChild(callout);

  const timer = setTimeout(() => {
    if (callout.parentNode) callout.remove();
  }, duration);
}
