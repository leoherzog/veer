import { env } from "cloudflare:workers";
import { describe, it, expect, vi } from "vitest";
import { api, cachedRedirect, uniq } from "../helpers";
import { setCachedRedirect, type CachedRedirect, type CachedTarget } from "../../src/services/kv-cache";

const DEFAULT = "https://default.example.com/";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0";

const geo = (matchValue: string, destinationUrl: string, priority = 10): CachedTarget =>
  ({ type: "geo", matchValue, destinationUrl, priority });
const device = (matchValue: string, destinationUrl: string, priority = 10): CachedTarget =>
  ({ type: "device", matchValue, destinationUrl, priority });
const ab = (matchValue: string, destinationUrl: string): CachedTarget =>
  ({ type: "ab", matchValue, destinationUrl, priority: 0 });

type Visitor = { cf?: Record<string, unknown>; ua?: string };

/** Cache a link under a fresh slug, defaulting to DEFAULT with no targets, and return the slug. */
async function cacheLink(overrides: Partial<CachedRedirect> = {}): Promise<string> {
  const slug = uniq("link");
  await setCachedRedirect(env.KV, slug, cachedRedirect({ url: DEFAULT, ...overrides }));
  return slug;
}

/** GET `path` as a visitor with the given cf properties and user agent. */
function visit(path: string, { cf, ua }: Visitor = {}, testEnv?: Cloudflare.Env) {
  return api("GET", path, { cf, headers: ua ? { "User-Agent": ua } : {}, env: testEnv });
}

/** An Analytics Engine binding that records each data point. */
function recordingAnalytics() {
  const writeDataPoint = vi.fn<(point?: AnalyticsEngineDataPoint) => void>();
  return { writeDataPoint, env: { ...env, ANALYTICS: { writeDataPoint } } };
}

describe("Targeting evaluation via redirect", () => {
  // Every roll picks the first A/B variant, so a row whose rule wins proves it beat the roll.
  it.each<[string, CachedTarget[], Visitor, string]>([
    ["follows a matching geo rule", [geo("DE", "https://de.example.com")], { cf: { country: "DE" } }, "https://de.example.com"],
    ["ignores a geo rule for another country", [geo("JP", "https://jp.example.com")], { cf: { country: "US" } }, DEFAULT],
    ["matches a geo rule case-insensitively", [geo("gb", "https://uk.example.com")], { cf: { country: "GB" } }, "https://uk.example.com"],
    ["follows a mobile rule on an iPhone", [device("mobile", "https://m.example.com")], { ua: IPHONE }, "https://m.example.com"],
    ["follows a tablet rule on an iPad", [device("tablet", "https://tablet.example.com")], { ua: IPAD }, "https://tablet.example.com"],
    ["ignores a mobile rule on a desktop", [device("mobile", "https://m.example.com")], { ua: MAC }, DEFAULT],
    [
      "picks the higher-priority of two matching rules",
      [geo("US", "https://low.example.com", 1), geo("US", "https://high.example.com", 10)],
      { cf: { country: "US" } },
      "https://high.example.com",
    ],
    [
      "picks the first of two matching rules with equal priority",
      [geo("US", "https://first.example.com"), geo("US", "https://second.example.com")],
      { cf: { country: "US" } },
      "https://first.example.com",
    ],
    [
      "puts a higher-priority geo rule ahead of a matching device rule",
      [device("mobile", "https://m.example.com", 1), geo("FR", "https://fr.example.com", 10)],
      { cf: { country: "FR" }, ua: IPHONE },
      "https://fr.example.com",
    ],
    [
      "puts a matching geo rule ahead of an A/B variant",
      [ab("50", "https://variant.example.com"), geo("FR", "https://fr.example.com", 5)],
      { cf: { country: "FR" } },
      "https://fr.example.com",
    ],
    [
      "rolls A/B when no geo or device rule matches",
      [geo("US", "https://us.example.com", 5), ab("50", "https://variant.example.com")],
      { cf: { country: "FR" } },
      "https://variant.example.com",
    ],
    ["keeps the link's own URL when it has no targets", [], {}, DEFAULT],
  ])("%s", async (_title, targets, visitor, location) => {
    const slug = await cacheLink({ targets });
    vi.spyOn(Math, "random").mockReturnValue(0);

    const res = await visit(`/${slug}`, visitor);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(location);
  });

  it("a geo rule pointing at the default URL never rolls A/B", async () => {
    const slug = await cacheLink({ targets: [ab("99", "https://variant.example.com"), geo("US", DEFAULT, 5)] });
    const random = vi.spyOn(Math, "random");

    const res = await visit(`/${slug}`, { cf: { country: "US" } });

    expect(res.headers.get("Location")).toBe(DEFAULT);
    expect(random).not.toHaveBeenCalled();
  });
});

describe("A/B roll", () => {
  // Variants fill [0, sum of weights); the default takes 100 minus that sum,
  // floored at 1, and the roll is Math.random() times the whole span.
  const pair = [ab("50", "https://a.example.com"), ab("50", "https://b.example.com")];

  it.each<[string, CachedTarget[], number, string]>([
    ["a low roll on a 50/50 pair picks the first variant", pair, 0, "https://a.example.com"],
    ["a mid roll on a 50/50 pair picks the second variant", pair, 0.5, "https://b.example.com"],
    ["the top of a 50/50 pair's 101-wide span lands on the default's floor", pair, 0.995, DEFAULT],
    // A weight of 100 clamped to 99 covers [0, 99) of a 100-wide span. A clamp
    // below 99 loses the 98.995 roll; no clamp covers [0, 100) of 101 and takes 99.995.
    ["a weight of 100 clamps to 99: a roll just under 99 picks the variant", [ab("100", "https://variant.example.com")], 0.98995, "https://variant.example.com"],
    ["a weight of 100 clamps to 99: a roll at 99 lands on the default", [ab("100", "https://variant.example.com")], 0.99005, DEFAULT],
    // A non-numeric weight counted as 1 covers [0, 1) of a 100-wide span.
    ["a non-numeric weight counts as 1: a roll under 1 picks the variant", [ab("not-a-number", "https://variant.example.com")], 0.005, "https://variant.example.com"],
    ["a non-numeric weight counts as 1: a roll past 1 lands on the default", [ab("not-a-number", "https://variant.example.com")], 0.015, DEFAULT],
  ])("%s", async (_title, targets, roll, location) => {
    const slug = await cacheLink({ targets });
    vi.spyOn(Math, "random").mockReturnValue(roll);

    const res = await visit(`/${slug}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(location);
  });
});

describe("Param forwarding via redirect", () => {
  it("appends incoming params to destination", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com/page", paramForwarding: true });

    const res = await visit(`/${slug}?utm_source=twitter&ref=home`);

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("utm_source")).toBe("twitter");
    expect(loc.searchParams.get("ref")).toBe("home");
    expect(loc.origin + loc.pathname).toBe("https://dest.example.com/page");
  });

  it("keeps a param the destination already has at its own value, once", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com/page?existing=1", paramForwarding: true });

    const res = await visit(`/${slug}?existing=2&extra=yes`);

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.getAll("existing")).toEqual(["1"]);
    expect(loc.searchParams.get("extra")).toBe("yes");
  });

  it("forwards multi-valued params correctly", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com/page", paramForwarding: true });

    const res = await visit(`/${slug}?tag=a&tag=b&tag=c`);

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.getAll("tag")).toEqual(["a", "b", "c"]);
  });

  it("destination unchanged when no incoming params", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com/page", paramForwarding: true });

    const res = await visit(`/${slug}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://dest.example.com/page");
  });

  it("keeps the destination's own query string as written", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com/page?q=a%20b&list=1,2&flag#top", paramForwarding: true });

    const res = await visit(`/${slug}?flag=1&utm_source=x`);

    expect(res.headers.get("Location")).toBe("https://dest.example.com/page?q=a%20b&list=1,2&flag&utm_source=x#top");
  });

  it("leaves the destination untouched when every incoming key is already on it", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com/page?q=a%20b&list=1,2", paramForwarding: true });

    const res = await visit(`/${slug}?q=other`);

    expect(res.headers.get("Location")).toBe("https://dest.example.com/page?q=a%20b&list=1,2");
  });

  it("does not forward params when paramForwarding is false", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com/page" });

    const res = await visit(`/${slug}?utm_source=twitter&ref=home`);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://dest.example.com/page");
  });

  it("applies param forwarding to the targeted destination, not the default", async () => {
    const slug = await cacheLink({
      url: "https://default.example.com/page",
      paramForwarding: true,
      targets: [geo("DE", "https://de.example.com/landing")],
    });

    const res = await visit(`/${slug}?campaign=spring`, { cf: { country: "DE" } });

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://de.example.com/landing");
    expect(loc.searchParams.get("campaign")).toBe("spring");
  });
});

describe("Click logging", () => {
  it("records the chosen A/B variant, not the URL with forwarded params", async () => {
    const slug = await cacheLink({ paramForwarding: true, targets: [ab("50", "https://a.example.com/landing")] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const analytics = recordingAnalytics();

    const res = await visit(`/${slug}?utm_source=newsletter`, {}, analytics.env);

    expect(res.headers.get("Location")).toBe("https://a.example.com/landing?utm_source=newsletter");
    expect(analytics.writeDataPoint).toHaveBeenCalledOnce();
    expect(analytics.writeDataPoint.mock.calls[0][0]?.blobs?.[5]).toBe("https://a.example.com/landing");
  });
});

describe("OG meta page (bot/crawler)", () => {
  it("renders og:url from the request URL", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com", ogTitle: "Hello" });

    const res = await visit(`/${slug}`, { ua: "facebookexternalhit/1.1" });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`<meta property="og:url" content="http://localhost/${slug}"`);
  });

  it("HTML-escapes og:title so embedded quotes/angle brackets cannot break out", async () => {
    const slug = await cacheLink({
      url: "https://dest.example.com",
      ogTitle: '<script>alert(1)</script>"evil"',
      ogDescription: "Desc with <b> & 'apostrophe'",
      ogImage: "https://img.example.com/a.png?x=<y>",
    });

    const res = await visit(`/${slug}`, { ua: "Twitterbot/1.0" });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;");
    // Escaped double quotes cannot close the content attribute.
    expect(html).toContain("&quot;evil&quot;");
    expect(html).toContain("?x=&lt;y&gt;");
  });

  it("omits og:image tag when ogImage is null", async () => {
    const slug = await cacheLink({ url: "https://dest.example.com", ogTitle: "Only title", ogImage: null });

    const res = await visit(`/${slug}`, { ua: "LinkedInBot" });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title"');
    expect(html).not.toContain('property="og:image"');
  });
});
