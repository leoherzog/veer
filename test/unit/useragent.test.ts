import { describe, it, expect } from "vitest";
import { parseUserAgent, parseDevice } from "../../src/services/useragent";

// Real-world UA strings
const UAs = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  chromeLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  chromeAndroidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  chromeIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1",
  firefoxWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  firefoxMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
  firefoxLinux:
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  firefoxAndroid:
    "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0",
  firefoxIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/604.1",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  safariIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  safariIPad:
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  edgeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
  chromeOS:
    "Mozilla/5.0 (X11; CrOS x86_64 15236.80.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
  googlebot:
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  iPodTouch:
    "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15",
  operaMini:
    "Opera/9.80 (J2ME/MIDP; Opera Mini/5.1.21214/28.2725; U; ru) Presto/2.8.119 Version/11.10",
  ieMobile:
    "Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0; IEMobile/10.0)",
  genericTablet:
    "Mozilla/5.0 (Linux; U; Tablet; en-US) AppleWebKit/537.36",
  blackberry:
    "Mozilla/5.0 (BlackBerry; U; BlackBerry 9900; en) AppleWebKit/534.11+ (KHTML, like Gecko) Version/7.1.0.346 Mobile Safari/534.11+",
};

describe("parseUserAgent — browser detection", () => {
  it("detects Chrome on Windows", () => {
    expect(parseUserAgent(UAs.chromeWindows).browser).toBe("Chrome");
  });

  it("detects Chrome on macOS", () => {
    expect(parseUserAgent(UAs.chromeMac).browser).toBe("Chrome");
  });

  it("detects Chrome on Linux", () => {
    expect(parseUserAgent(UAs.chromeLinux).browser).toBe("Chrome");
  });

  it("detects Chrome on Android (mobile)", () => {
    expect(parseUserAgent(UAs.chromeAndroid).browser).toBe("Chrome");
  });

  it("detects Chrome on iOS (CriOS)", () => {
    expect(parseUserAgent(UAs.chromeIOS).browser).toBe("Chrome");
  });

  it("detects Firefox on Windows", () => {
    expect(parseUserAgent(UAs.firefoxWindows).browser).toBe("Firefox");
  });

  it("detects Firefox on macOS", () => {
    expect(parseUserAgent(UAs.firefoxMac).browser).toBe("Firefox");
  });

  it("detects Firefox on Linux", () => {
    expect(parseUserAgent(UAs.firefoxLinux).browser).toBe("Firefox");
  });

  it("detects Firefox on Android", () => {
    expect(parseUserAgent(UAs.firefoxAndroid).browser).toBe("Firefox");
  });

  it("detects Firefox on iOS (FxiOS)", () => {
    expect(parseUserAgent(UAs.firefoxIOS).browser).toBe("Firefox");
  });

  it("detects Safari on macOS", () => {
    expect(parseUserAgent(UAs.safariMac).browser).toBe("Safari");
  });

  it("detects Safari on iPhone", () => {
    expect(parseUserAgent(UAs.safariIPhone).browser).toBe("Safari");
  });

  it("detects Safari on iPad", () => {
    expect(parseUserAgent(UAs.safariIPad).browser).toBe("Safari");
  });

  it("detects Edge on Windows (not Chrome)", () => {
    expect(parseUserAgent(UAs.edgeWindows).browser).toBe("Edge");
  });

  it("detects Edge on macOS (not Chrome)", () => {
    expect(parseUserAgent(UAs.edgeMac).browser).toBe("Edge");
  });

  it("detects Opera", () => {
    expect(parseUserAgent(UAs.opera).browser).toBe("Opera");
  });

  it("detects Samsung Internet", () => {
    expect(parseUserAgent(UAs.samsung).browser).toBe("Samsung Internet");
  });

  it("returns Other for an unknown UA", () => {
    expect(parseUserAgent("SomeUnknownAgent/1.0").browser).toBe("Other");
  });

  it("returns Other for an empty string", () => {
    expect(parseUserAgent("").browser).toBe("Other");
  });
});

describe("parseUserAgent — OS detection", () => {
  it("detects Windows", () => {
    expect(parseUserAgent(UAs.chromeWindows).os).toBe("Windows");
  });

  it("detects macOS from Chrome", () => {
    expect(parseUserAgent(UAs.chromeMac).os).toBe("macOS");
  });

  it("detects macOS from Safari", () => {
    expect(parseUserAgent(UAs.safariMac).os).toBe("macOS");
  });

  it("detects Linux", () => {
    expect(parseUserAgent(UAs.chromeLinux).os).toBe("Linux");
  });

  it("detects Android from Chrome mobile", () => {
    expect(parseUserAgent(UAs.chromeAndroid).os).toBe("Android");
  });

  it("detects Android from Firefox", () => {
    expect(parseUserAgent(UAs.firefoxAndroid).os).toBe("Android");
  });

  it("detects iOS from iPhone Safari", () => {
    expect(parseUserAgent(UAs.safariIPhone).os).toBe("iOS");
  });

  it("detects iOS from iPad Safari", () => {
    expect(parseUserAgent(UAs.safariIPad).os).toBe("iOS");
  });

  it("detects iOS from Chrome on iPhone (CriOS)", () => {
    expect(parseUserAgent(UAs.chromeIOS).os).toBe("iOS");
  });

  it("detects iOS from Firefox on iPhone (FxiOS)", () => {
    expect(parseUserAgent(UAs.firefoxIOS).os).toBe("iOS");
  });

  it("detects Chrome OS", () => {
    expect(parseUserAgent(UAs.chromeOS).os).toBe("Chrome OS");
  });

  it("returns Other for an empty string", () => {
    expect(parseUserAgent("").os).toBe("Other");
  });

  it("returns Other for an unknown UA", () => {
    expect(parseUserAgent("SomeUnknownAgent/1.0").os).toBe("Other");
  });
});

describe("parseUserAgent — device detection", () => {
  it("classifies Windows desktop as desktop", () => {
    expect(parseUserAgent(UAs.chromeWindows).device).toBe("desktop");
  });

  it("classifies macOS as desktop", () => {
    expect(parseUserAgent(UAs.safariMac).device).toBe("desktop");
  });

  it("classifies Linux desktop as desktop", () => {
    expect(parseUserAgent(UAs.chromeLinux).device).toBe("desktop");
  });

  it("classifies Chrome OS as desktop", () => {
    expect(parseUserAgent(UAs.chromeOS).device).toBe("desktop");
  });

  it("classifies Android phone (Chrome) as mobile", () => {
    expect(parseUserAgent(UAs.chromeAndroid).device).toBe("mobile");
  });

  it("classifies Android phone (Firefox) as mobile", () => {
    expect(parseUserAgent(UAs.firefoxAndroid).device).toBe("mobile");
  });

  it("classifies iPhone as mobile", () => {
    expect(parseUserAgent(UAs.safariIPhone).device).toBe("mobile");
  });

  it("classifies iPhone with CriOS as mobile", () => {
    expect(parseUserAgent(UAs.chromeIOS).device).toBe("mobile");
  });

  it("classifies iPad as tablet", () => {
    expect(parseUserAgent(UAs.safariIPad).device).toBe("tablet");
  });

  it("classifies Android tablet (no 'Mobile' token) as tablet", () => {
    // SM-X710 tablet UA does not contain 'Mobile'
    expect(parseUserAgent(UAs.chromeAndroidTablet).device).toBe("tablet");
  });

  it("classifies Samsung phone as mobile", () => {
    // Samsung browser UA contains 'Mobile'
    expect(parseUserAgent(UAs.samsung).device).toBe("mobile");
  });

  it("returns desktop for empty UA", () => {
    expect(parseUserAgent("").device).toBe("desktop");
  });
});

describe("parseUserAgent — bot/crawler detection", () => {
  it("Googlebot has no mobile signals — classified as desktop", () => {
    // The function doesn't have explicit bot detection, so Googlebot
    // falls through to defaults. Verify stable behavior.
    const info = parseUserAgent(UAs.googlebot);
    expect(info.device).toBe("desktop");
    expect(info.browser).toBe("Other");
    expect(info.os).toBe("Other");
  });
});

describe("parseUserAgent — edge cases", () => {
  it("handles a UA with only whitespace", () => {
    const info = parseUserAgent("   ");
    expect(info.browser).toBe("Other");
    expect(info.os).toBe("Other");
    expect(info.device).toBe("desktop");
  });

  it("returns the full UAInfo shape with all three fields", () => {
    const info = parseUserAgent(UAs.chromeWindows);
    expect(info).toHaveProperty("browser");
    expect(info).toHaveProperty("os");
    expect(info).toHaveProperty("device");
  });
});

// parseDevice is the single classifier behind both device targeting on the
// redirect path and the device breakdown in stats.
describe("parseDevice — redirect targeting parity", () => {
  it("classifies iPod touch as mobile", () => {
    expect(parseDevice(UAs.iPodTouch)).toBe("mobile");
  });

  it("classifies Opera Mini as mobile", () => {
    expect(parseDevice(UAs.operaMini)).toBe("mobile");
  });

  it("classifies IEMobile as mobile", () => {
    expect(parseDevice(UAs.ieMobile)).toBe("mobile");
  });

  it("classifies BlackBerry as mobile", () => {
    expect(parseDevice(UAs.blackberry)).toBe("mobile");
  });

  it("classifies a generic Tablet UA as tablet", () => {
    expect(parseDevice(UAs.genericTablet)).toBe("tablet");
  });

  it("classifies an Android UA without \"Mobile\" as tablet", () => {
    expect(parseDevice(UAs.chromeAndroidTablet)).toBe("tablet");
  });

  it("classifies desktop Chrome as desktop", () => {
    expect(parseDevice(UAs.chromeWindows)).toBe("desktop");
  });

  it("classifies an empty UA as desktop", () => {
    expect(parseDevice("")).toBe("desktop");
  });

  it("agrees with the device field parseUserAgent reports", () => {
    for (const ua of Object.values(UAs)) {
      expect(parseDevice(ua)).toBe(parseUserAgent(ua).device);
    }
  });
});
