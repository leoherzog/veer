import { escapeAttr } from "../lib/escape.js";

const DISPLAY_SIZE = 150;
const DOWNLOAD_SIZE = 500;

/**
 * Draw the QR at download resolution. The on-screen code is 150px, so exporting
 * its canvas would upscale; this renders a throwaway `wa-qr-code` at the target
 * size instead. The component draws its canvas at 2x for high-density displays,
 * which the final downscale to `DOWNLOAD_SIZE` resolves cleanly.
 */
async function renderForDownload(source) {
  const el = document.createElement("wa-qr-code");
  el.value = source.value;
  el.label = source.label;
  el.size = DOWNLOAD_SIZE;
  el.errorCorrection = source.errorCorrection;
  el.fill = source.fill || getComputedStyle(source).color;
  el.background = source.background;
  const corner = getComputedStyle(source).getPropertyValue("--corner-color").trim();
  if (corner) el.style.setProperty("--corner-color", corner);
  el.style.position = "fixed";
  el.style.insetBlockStart = "-9999px";
  document.body.append(el);
  try {
    await el.updateComplete;
    const canvas = el.shadowRoot?.querySelector("canvas");
    if (!canvas) return null;
    const out = document.createElement("canvas");
    out.width = DOWNLOAD_SIZE;
    out.height = DOWNLOAD_SIZE;
    out.getContext("2d").drawImage(canvas, 0, 0, DOWNLOAD_SIZE, DOWNLOAD_SIZE);
    return out.toDataURL("image/png");
  } finally {
    el.remove();
  }
}

export function renderQrCode(container, shortUrl) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-xs wa-align-items-center">
      <wa-qr-code value="${escapeAttr(shortUrl)}" size="${DISPLAY_SIZE}" label="QR code for short URL" error-correction="H"></wa-qr-code>
      <div class="wa-cluster wa-gap-s wa-align-items-center">
        <span class="wa-caption-xs">QR</span>
        <wa-color-picker id="qr-fill-color" value="#000000" without-format-toggle size="s"></wa-color-picker>
        <span class="wa-caption-xs">BG</span>
        <wa-color-picker id="qr-bg-color" value="#ffffff" without-format-toggle size="s"></wa-color-picker>
      </div>
      <wa-button size="s" appearance="outlined" id="qr-download-png" aria-label="Download QR code as PNG">
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

  container.querySelector("#qr-download-png").addEventListener("click", async () => {
    const href = await renderForDownload(qrEl);
    if (!href) return;
    const a = document.createElement("a");
    a.href = href;
    a.download = "qr-code.png";
    a.click();
  });
}
