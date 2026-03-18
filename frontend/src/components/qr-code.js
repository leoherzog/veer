import { escapeAttr } from "../lib/escape.js";

export function renderQrCode(container, shortUrl) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-xs" style="align-items:center;">
      <wa-qr-code value="${escapeAttr(shortUrl)}" size="150" label="QR code for short URL" error-correction="H"></wa-qr-code>
      <wa-button size="small" appearance="outlined" id="qr-download-png" aria-label="Download QR code as PNG">
        <wa-icon slot="start" name="download"></wa-icon>
        PNG
      </wa-button>
    </div>
  `;

  const qrEl = container.querySelector("wa-qr-code");

  container.querySelector("#qr-download-png").addEventListener("click", () => {
    const canvas = qrEl.shadowRoot.querySelector("canvas");
    if (!canvas) return;
    const out = document.createElement("canvas");
    out.width = 500;
    out.height = 500;
    out.getContext("2d").drawImage(canvas, 0, 0, 500, 500);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = "qr-code.png";
    a.click();
  });
}
