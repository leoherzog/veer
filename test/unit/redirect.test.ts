import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import app from "../../src/index";
import { setupAuth, mockExecutionCtx } from "../helpers";
import { setCachedRedirect } from "../../src/services/kv-cache";
import { detectDeviceType } from "../../src/routes/redirect";

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a cached redirect entry with sensible defaults; override as needed. */
function cachedRedirect(overrides: Partial<Parameters<typeof setCachedRedirect>[2]> = {}) {
  return {
    url: "https://default.example.com",
    redirectType: 302,
    linkId: `link-${crypto.randomUUID().slice(0, 8)}`,
    isActive: true,
    expiresAt: null,
    maxClicks: null,
    hasPassword: false,
    isInternal: false,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    paramForwarding: false,
    targets: null,
    domainHostname: null,
    ...overrides,
  };
}

/**
 * Create a Request with a `.cf` property (simulates Cloudflare's IncomingRequestCfProperties).
 * Hono reads `(req as any).cf` for geo data.
 */
function cfRequest(
  path: string,
  options: { headers?: Record<string, string>; cf?: Record<string, unknown> } = {},
): Request {
  const url = `http://localhost${path}`;
  // Workers runtime Request constructor accepts `cf` in the init object
  const init: RequestInit & { cf?: Record<string, unknown> } = {
    headers: options.headers,
  };
  if (options.cf) {
    init.cf = options.cf;
  }
  return new Request(url, init);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("detectDeviceType()", () => {
  it("classifies iPhone UA as mobile", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(detectDeviceType(ua)).toBe("mobile");
  });

  it("classifies Android phone UA as mobile", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(detectDeviceType(ua)).toBe("mobile");
  });

  it("classifies iPad UA as tablet", () => {
    const ua = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(detectDeviceType(ua)).toBe("tablet");
  });

  it("classifies Android tablet UA as tablet", () => {
    // Android tablet UAs typically have "Android" but NOT "Mobile"
    const ua = "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(detectDeviceType(ua)).toBe("tablet");
  });

  it("classifies desktop Chrome UA as desktop", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(detectDeviceType(ua)).toBe("desktop");
  });

  it("classifies empty string as desktop", () => {
    expect(detectDeviceType("")).toBe("desktop");
  });
});

describe("Targeting evaluation via redirect", () => {
  let auth: Awaited<ReturnType<typeof setupAuth>>;

  beforeAll(async () => {
    auth = await setupAuth(env);
  });

  describe("geo targeting", () => {
    it("matches geo rule and redirects to target destination", async () => {
      await setCachedRedirect(env.KV, "geo-de", cachedRedirect({
        url: "https://default.example.com/fallback",
        targets: [
          { type: "geo", matchValue: "DE", destinationUrl: "https://de.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/geo-de", {
        cf: { country: "DE" },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://de.example.com");
    });

    it("falls back to default when geo rule does not match", async () => {
      await setCachedRedirect(env.KV, "geo-miss", cachedRedirect({
        url: "https://default.example.com/geo-miss",
        targets: [
          { type: "geo", matchValue: "JP", destinationUrl: "https://jp.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/geo-miss", {
        cf: { country: "US" },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://default.example.com/geo-miss");
    });

    it("geo matching is case-insensitive", async () => {
      await setCachedRedirect(env.KV, "geo-case", cachedRedirect({
        url: "https://default.example.com/geo-case",
        targets: [
          { type: "geo", matchValue: "gb", destinationUrl: "https://uk.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/geo-case", {
        cf: { country: "GB" },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://uk.example.com");
    });
  });

  describe("device targeting", () => {
    it("matches mobile device rule", async () => {
      await setCachedRedirect(env.KV, "dev-mobile", cachedRedirect({
        url: "https://default.example.com/dev-mobile",
        targets: [
          { type: "device", matchValue: "mobile", destinationUrl: "https://m.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/dev-mobile", {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://m.example.com");
    });

    it("matches tablet device rule", async () => {
      await setCachedRedirect(env.KV, "dev-tablet", cachedRedirect({
        url: "https://default.example.com/dev-tablet",
        targets: [
          { type: "device", matchValue: "tablet", destinationUrl: "https://tablet.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/dev-tablet", {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://tablet.example.com");
    });

    it("desktop user does not match mobile rule, falls back to default", async () => {
      await setCachedRedirect(env.KV, "dev-desktop-miss", cachedRedirect({
        url: "https://default.example.com/desktop-fallback",
        targets: [
          { type: "device", matchValue: "mobile", destinationUrl: "https://m.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/dev-desktop-miss", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
        },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://default.example.com/desktop-fallback");
    });
  });

  describe("priority and ordering", () => {
    it("higher priority rule wins over lower priority", async () => {
      await setCachedRedirect(env.KV, "prio-high-low", cachedRedirect({
        url: "https://default.example.com/prio",
        targets: [
          { type: "geo", matchValue: "US", destinationUrl: "https://low-prio.example.com", priority: 1 },
          { type: "geo", matchValue: "US", destinationUrl: "https://high-prio.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/prio-high-low", {
        cf: { country: "US" },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://high-prio.example.com");
    });

    it("first match wins among same priority rules", async () => {
      // When priorities are equal, the sort is stable and iteration order
      // determines which one matches first. Both geo:US rules have priority 10,
      // but since sort is descending by priority, ties preserve insertion order.
      // The first US rule in the array should win after sort.
      await setCachedRedirect(env.KV, "prio-same", cachedRedirect({
        url: "https://default.example.com/same-prio",
        targets: [
          { type: "geo", matchValue: "US", destinationUrl: "https://first.example.com", priority: 10 },
          { type: "geo", matchValue: "US", destinationUrl: "https://second.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/prio-same", {
        cf: { country: "US" },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://first.example.com");
    });

    it("geo rule at higher priority beats device rule at lower priority", async () => {
      await setCachedRedirect(env.KV, "prio-geo-dev", cachedRedirect({
        url: "https://default.example.com/mixed",
        targets: [
          { type: "device", matchValue: "mobile", destinationUrl: "https://mobile.example.com", priority: 1 },
          { type: "geo", matchValue: "FR", destinationUrl: "https://fr.example.com", priority: 10 },
        ],
      }));

      const req = cfRequest("/prio-geo-dev", {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        },
        cf: { country: "FR" },
      });
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://fr.example.com");
    });
  });

  describe("no rules match", () => {
    it("returns default destination when no targeting rules exist", async () => {
      await setCachedRedirect(env.KV, "no-targets", cachedRedirect({
        url: "https://default.example.com/plain",
        targets: null,
        domainHostname: null,
      }));

      const req = cfRequest("/no-targets");
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://default.example.com/plain");
    });

    it("returns default destination with empty targets array", async () => {
      await setCachedRedirect(env.KV, "empty-targets", cachedRedirect({
        url: "https://default.example.com/empty",
        targets: [],
      }));

      const req = cfRequest("/empty-targets");
      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://default.example.com/empty");
    });
  });
});

describe("Param forwarding via redirect", () => {
  it("appends incoming params to destination", async () => {
    await setCachedRedirect(env.KV, "pf-append", cachedRedirect({
      url: "https://dest.example.com/page",
      paramForwarding: true,
    }));

    const req = cfRequest("/pf-append?utm_source=twitter&ref=home");
    const res = await app.fetch(req, env, mockExecutionCtx());

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("utm_source")).toBe("twitter");
    expect(loc.searchParams.get("ref")).toBe("home");
    expect(loc.origin + loc.pathname).toBe("https://dest.example.com/page");
  });

  it("preserves existing destination params and does not duplicate them", async () => {
    await setCachedRedirect(env.KV, "pf-existing", cachedRedirect({
      url: "https://dest.example.com/page?existing=1",
      paramForwarding: true,
    }));

    const req = cfRequest("/pf-existing?existing=2&extra=yes");
    const res = await app.fetch(req, env, mockExecutionCtx());

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    // Existing param kept at original value, NOT overwritten
    expect(loc.searchParams.get("existing")).toBe("1");
    // Only one "existing" param
    expect(loc.searchParams.getAll("existing")).toEqual(["1"]);
    // New param appended
    expect(loc.searchParams.get("extra")).toBe("yes");
  });

  it("forwards multi-valued params correctly", async () => {
    await setCachedRedirect(env.KV, "pf-multi", cachedRedirect({
      url: "https://dest.example.com/page",
      paramForwarding: true,
    }));

    const req = cfRequest("/pf-multi?tag=a&tag=b&tag=c");
    const res = await app.fetch(req, env, mockExecutionCtx());

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.getAll("tag")).toEqual(["a", "b", "c"]);
  });

  it("destination unchanged when no incoming params", async () => {
    await setCachedRedirect(env.KV, "pf-empty", cachedRedirect({
      url: "https://dest.example.com/page",
      paramForwarding: true,
    }));

    const req = cfRequest("/pf-empty");
    const res = await app.fetch(req, env, mockExecutionCtx());

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://dest.example.com/page");
  });

  it("does not forward params when paramForwarding is false", async () => {
    await setCachedRedirect(env.KV, "pf-off", cachedRedirect({
      url: "https://dest.example.com/page",
      paramForwarding: false,
    }));

    const req = cfRequest("/pf-off?utm_source=twitter&ref=home");
    const res = await app.fetch(req, env, mockExecutionCtx());

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://dest.example.com/page");
  });
});

describe("Targeting + param forwarding combined", () => {
  it("applies param forwarding to the targeted destination, not the default", async () => {
    await setCachedRedirect(env.KV, "combo-target-pf", cachedRedirect({
      url: "https://default.example.com/page",
      paramForwarding: true,
      targets: [
        { type: "geo", matchValue: "DE", destinationUrl: "https://de.example.com/landing", priority: 10 },
      ],
    }));

    const req = cfRequest("/combo-target-pf?campaign=spring", {
      cf: { country: "DE" },
    });
    const res = await app.fetch(req, env, mockExecutionCtx());

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://de.example.com/landing");
    expect(loc.searchParams.get("campaign")).toBe("spring");
  });
});
