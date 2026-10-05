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
  const cs = getComputedStyle(source);
  el.style.color = cs.color;
  el.style.position = "fixed";
  el.style.insetBlockStart = "-9999px";
  document.body.append(el);
  try {
    await el.updateComplete;
    const out = document.createElement("canvas");
    out.width = DOWNLOAD_SIZE;
    out.height = DOWNLOAD_SIZE;
    const ctx = out.getContext("2d");
    // The QR canvas is transparent; the background is host CSS, so paint it in.
    ctx.fillStyle = cs.backgroundColor;
    ctx.fillRect(0, 0, DOWNLOAD_SIZE, DOWNLOAD_SIZE);
    ctx.drawImage(el.canvas, 0, 0, DOWNLOAD_SIZE, DOWNLOAD_SIZE);
    return out.toDataURL("image/png");
  } finally {
    el.remove();
  }
}

export function renderQrCode(container, shortUrl) {
  container.innerHTML = `
    <div class="wa-stack wa-gap-xs wa-align-items-center">
      <wa-qr-code value="${escapeAttr(shortUrl)}" size="${DISPLAY_SIZE}" label="QR code for short URL"></wa-qr-code>
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

  container.querySelector("#qr-fill-color").addEventListener("change", (e) => {
    qrEl.style.color = e.target.value;
  });
  container.querySelector("#qr-bg-color").addEventListener("change", (e) => {
    qrEl.style.backgroundColor = e.target.value;
  });

  container.querySelector("#qr-download-png").addEventListener("click", async () => {
    const href = await renderForDownload(qrEl);
    const a = document.createElement("a");
    a.href = href;
    a.download = "qr-code.png";
    a.click();
  });
}
