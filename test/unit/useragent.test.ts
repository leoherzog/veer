import { describe, it, expect } from "vitest";
import { parseUserAgent, parseDevice, DEVICE_TYPES } from "../../src/services/useragent";

// Real-world UA strings with the full { browser, os, device } each parses to.
const PARSED: [label: string, ua: string, browser: string, os: string, device: string][] = [
  ["Chrome on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Chrome", "Windows", "desktop"],
  ["Chrome on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Chrome", "macOS", "desktop"],
  ["Chrome on Linux", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Chrome", "Linux", "desktop"],
  ["Chrome on an Android phone", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36", "Chrome", "Android", "mobile"],
  // An Android UA without a "Mobile" token is a tablet.
  ["Chrome on an Android tablet", "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Chrome", "Android", "tablet"],
  ["Chrome on iPhone (CriOS)", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1", "Chrome", "iOS", "mobile"],
  ["Chrome OS", "Mozilla/5.0 (X11; CrOS x86_64 15236.80.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36", "Chrome", "Chrome OS", "desktop"],
  ["Firefox on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0", "Firefox", "Windows", "desktop"],
  ["Firefox on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0", "Firefox", "macOS", "desktop"],
  ["Firefox on Linux", "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", "Firefox", "Linux", "desktop"],
  ["Firefox on Android", "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0", "Firefox", "Android", "mobile"],
  ["Firefox on iPhone (FxiOS)", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/604.1", "Firefox", "iOS", "mobile"],
  ["Safari on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", "Safari", "macOS", "desktop"],
  ["Safari on iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "Safari", "iOS", "mobile"],
  ["Safari on iPad", "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "Safari", "iOS", "tablet"],
  ["Edge on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0", "Edge", "Windows", "desktop"],
  ["Edge on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0", "Edge", "macOS", "desktop"],
  ["Opera", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0", "Opera", "Windows", "desktop"],
  ["Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36", "Samsung Internet", "Android", "mobile"],
  // No bot detection: a crawler falls through to the defaults.
  ["Googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Other", "Other", "desktop"],
  ["an unknown UA", "SomeUnknownAgent/1.0", "Other", "Other", "desktop"],
  ["an empty UA", "", "Other", "Other", "desktop"],
  ["a whitespace-only UA", "   ", "Other", "Other", "desktop"],
];

// Device-only cases: their browser and OS fall outside what parseUserAgent names.
// Each UA carries only the parseDevice token its label names, so dropping that
// token fails the row. Real iPod and Windows Phone UAs also carry "iPhone" or
// "IEMobile", so those two are trimmed.
const DEVICES: [label: string, ua: string, device: string][] = [
  ["iPod, by its iPod token", "Mozilla/5.0 (iPod; U; CPU like Mac OS X; en) AppleWebKit/420.1 (KHTML, like Gecko)", "mobile"],
  ["Opera Mini, by its Opera Mini token", "Opera/9.80 (J2ME/MIDP; Opera Mini/5.1.21214/28.2725; U; ru) Presto/2.8.119 Version/11.10", "mobile"],
  ["IEMobile, by the Mobile in its IEMobile token", "Mozilla/4.0 (compatible; MSIE 6.0; Windows CE; IEMobile 7.11)", "mobile"],
  ["Windows Phone, by its Windows Phone token", "Mozilla/5.0 (compatible; MSIE 9.0; Windows Phone OS 7.5; Trident/5.0)", "mobile"],
  ["BlackBerry, by its BlackBerry token", "BlackBerry9700/5.0.0.351 Profile/MIDP-2.1 Configuration/CLDC-1.1 VendorID/167", "mobile"],
  ["a generic tablet, by its Tablet token", "Mozilla/5.0 (Linux; U; Tablet; en-US) AppleWebKit/537.36", "tablet"],
];

describe("parseUserAgent", () => {
  it.each(PARSED)("parses %s", (_label, ua, browser, os, device) => {
    expect(parseUserAgent(ua)).toEqual({ browser, os, device });
  });
});

describe("parseDevice", () => {
  it.each(DEVICES)("classifies %s", (_label, ua, device) => {
    expect(parseDevice(ua)).toBe(device);
  });

  // Targets validation accepts exactly DEVICE_TYPES, so every class parseDevice
  // returns must be listed there or its targets could never be saved.
  it("returns only DEVICE_TYPES values, and covers all of them", () => {
    const seen = new Set([...PARSED, ...DEVICES].map((row) => parseDevice(row[1])));
    expect([...seen].sort()).toEqual([...DEVICE_TYPES].sort());
  });
});
