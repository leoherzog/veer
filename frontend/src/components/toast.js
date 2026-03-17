export function showToast(message, variant = "primary", duration = 3000) {
  const toast = Object.assign(document.createElement("wa-toast"), {
    variant,
    duration,
  });
  toast.textContent = message;
  document.body.appendChild(toast);
  toast.addEventListener("wa-after-hide", () => toast.remove());
  toast.toast();
}
