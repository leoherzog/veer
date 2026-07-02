import { escapeAttr } from "../lib/escape.js";

export function renderQrCode(container, shortUrl) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-xs wa-align-items-center">
      <wa-qr-code value="${escapeAttr(shortUrl)}" size="150" label="QR code for short URL" error-correction="H"></wa-qr-code>
      <div class="wa-cluster wa-gap-s wa-align-items-center">
        <span class="wa-caption-xs">QR</span>
        <wa-color-picker id="qr-fill-color" value="#000000" without-format-toggle size="small"></wa-color-picker>
        <span class="wa-caption-xs">BG</span>
        <wa-color-picker id="qr-bg-color" value="#ffffff" without-format-toggle size="small"></wa-color-picker>
      </div>
      <wa-button size="small" appearance="outlined" id="qr-download-png" aria-label="Download QR code as PNG">
        <wa-icon slot="start" name="download"></wa-icon>
        PNG
      </wa-button>
    </div>
  `;

  const qrEl = container.querySelector("wa-qr-code");

  // Color pickers update QR in real-time
  container.querySelector("#qr-fill-color").addEventListener("change", (e) => {
    // fill only paints the data modules; the finder squares read --corner-color
    qrEl.style.setProperty("--corner-color", e.target.value);
    qrEl.fill = e.target.value;
  });
  container.querySelector("#qr-bg-color").addEventListener("change", (e) => {
    qrEl.background = e.target.value;
  });

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
