interface UAInfo {
  browser: string;
  os: string;
  device: "desktop" | "mobile" | "tablet";
}

export function parseUserAgent(ua: string): UAInfo {
  return {
    browser: parseBrowser(ua),
    os: parseOS(ua),
    device: parseDevice(ua),
  };
}

function parseBrowser(ua: string): string {
  // Order matters: Edge contains "Chrome", Safari UA contains "Chrome" too
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

function parseDevice(ua: string): "desktop" | "mobile" | "tablet" {
  // Tablet checks first
  if (/iPad/i.test(ua)) return "tablet";
  if (/Tablet/i.test(ua)) return "tablet";
  // Android without "Mobile" is typically a tablet
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "tablet";

  // Mobile checks
  if (/Mobile|iPhone|iPod/i.test(ua)) return "mobile";
  if (/Android/i.test(ua)) return "mobile";

  return "desktop";
}
