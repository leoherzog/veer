let container;
function getContainer() {
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message, variant = "neutral", duration = 3000) {
  const callout = document.createElement("wa-callout");
  callout.variant = variant;
  callout.textContent = message;
  getContainer().appendChild(callout);
  setTimeout(() => {
    if (callout.parentNode) callout.remove();
  }, duration);
}
