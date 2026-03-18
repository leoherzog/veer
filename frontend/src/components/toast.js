let toastEl;
function getToast() {
  if (!toastEl) {
    toastEl = document.createElement("wa-toast");
    document.body.appendChild(toastEl);
  }
  return toastEl;
}

export function showToast(message, variant = "neutral", duration = 3000) {
  getToast().create(message, { variant, duration });
}
