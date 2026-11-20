// User-agent parsing for redirect device targeting and click stats. The SPA bundles this module, so it must stay import-free.

/** Every device class parseDevice returns. */
export const DEVICE_TYPES = ["desktop", "mobile", "tablet"] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

interface UAInfo {
  browser: string;
  os: string;
  device: DeviceType;
}

export function parseUserAgent(ua: string): UAInfo {
  return {
    browser: parseBrowser(ua),
    os: parseOS(ua),
    device: parseDevice(ua),
  };
}

function parseBrowser(ua: string): string {
  // Order matters: Samsung, Opera and Edge UAs also contain "Chrome/", and
  // Chrome and iOS Firefox UAs contain "Safari/".
  if (/SamsungBrowser\//i.test(ua)) return "Samsung Internet";
  if (/OPR\/|Opera\//i.test(ua)) return "Opera";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome\/|CriOS\//i.test(ua)) return "Chrome";
  if (/Firefox\/|FxiOS\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua) && /AppleWebKit\//i.test(ua)) return "Safari";
  return "Other";
}

function parseOS(ua: string): string {
  if (/CrOS/i.test(ua)) return "Chrome OS";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}

/**
 * Classify a user agent as desktop, mobile or tablet. The single device
 * classifier: redirect device targeting and click stats both call it, so a
 * request always lands in the same bucket in both places.
 */
export function parseDevice(ua: string): DeviceType {
  // Tablets first: iPad UAs also contain "Mobile/".
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  // Android phones carry "Mobile" and fall to the mobile check below.
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "tablet";
  if (/Mobile|iPhone|iPod|webOS|BlackBerry|BB10|Opera Mini|Windows Phone/i.test(ua)) return "mobile";
  return "desktop";
}
