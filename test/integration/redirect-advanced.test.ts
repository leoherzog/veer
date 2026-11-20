import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  setupAuth, createTestLink, createTestDomain, insertClickStat, cachedRedirect, isoDaysAgo, api, expectSpaShell, totalClicks,
} from "../helpers";
import { getDb } from "../../src/db";
import { linkTargets } from "../../src/db/schema";
import { hashPassword } from "../../src/services/password";
import { getCachedRedirect, setCachedRedirect } from "../../src/services/kv-cache";

/** Insert a link_targets row. */
async function insertTarget(target: Omit<typeof linkTargets.$inferInsert, "id">) {
  await getDb(env.DB).insert(linkTargets).values({ id: crypto.randomUUID(), ...target });
}

/** Submit the password gate form for `slug`, omitting the field when `password` is undefined. */
function postPassword(slug: string, password?: string, opts: { headers?: Record<string, string>; ctx?: ExecutionContext; cf?: Record<string, unknown> } = {}) {
  return api("POST", `/${slug}`, {
    ...opts,
    body: new URLSearchParams(password === undefined ? {} : { password }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

let owner: Awaited<ReturnType<typeof setupAuth>>;

beforeAll(async () => {
  owner = await setupAuth();
});

describe("Redirect engine – advanced", () => {
  // ── handleRedirectPost (password gate POST) ────────────────────────────

  describe("handleRedirectPost – password gate", () => {
    const PASSWORD = "s3cret!";
    let passwordHash: string;

    beforeAll(async () => {
      passwordHash = await hashPassword(PASSWORD);
      await createTestLink({
        slug: "pw-post",
        destinationUrl: "https://example.com/pw-dest",
        password: passwordHash,
        userId: owner.user.id,
      });
      await createTestLink({
        slug: "no-pw-post",
        destinationUrl: "https://example.com/nopw",
        userId: owner.user.id,
      });
    });

    it("POST with correct password redirects to destination", async () => {
      const res = await postPassword("pw-post", PASSWORD);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/pw-dest");
    });

    it("POST with wrong password shows error page", async () => {
      const res = await postPassword("pw-post", "wrong");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Incorrect password");
    });

    it("POST with empty password shows error page", async () => {
      const res = await postPassword("pw-post", "");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Please enter a password");
    });

    it("POST with missing password field shows error page", async () => {
      const res = await postPassword("pw-post");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Please enter a password");
    });

    it("POST with a form over 4 KB returns 413 before the password is read", async () => {
      const res = await postPassword("pw-post", "x".repeat(5_000));

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Request body too large" });
    });

    it("POST for non-password link returns 405 with an Allow header", async () => {
      const res = await postPassword("no-pw-post", "whatever");

      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD");
    });

    it("POST checks constraints before the password, so a wrong password on an expired link still gets 410", async () => {
      await createTestLink({
        slug: "pw-expired-wrong",
        destinationUrl: "https://example.com/expired",
        password: passwordHash,
        expiresAt: new Date(Date.now() - 3_600_000),
        userId: owner.user.id,
      });

      const res = await postPassword("pw-expired-wrong", "wrong");

      expect(res.status).toBe(410);
    });

    it("POST with the correct password applies the link's targeting rules", async () => {
      const { id: linkId } = await createTestLink({
        slug: "pw-geo-post",
        destinationUrl: "https://example.com/pw-default",
        password: passwordHash,
        userId: owner.user.id,
      });
      await insertTarget({ linkId, type: "geo", matchValue: "DE", destinationUrl: "https://example.com/pw-de", priority: 1 });

      const res = await postPassword("pw-geo-post", PASSWORD, { cf: { country: "DE" } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/pw-de");
    });

    it("POST re-checks constraints (expired link)", async () => {
      const pastTs = new Date(Date.now() - 3_600_000);
      await createTestLink({
        slug: "pw-expired-post",
        destinationUrl: "https://example.com/expired",
        password: passwordHash,
        expiresAt: pastTs,
        userId: owner.user.id,
      });

      const res = await postPassword("pw-expired-post", PASSWORD);

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("expired");
    });

    it("POST re-checks constraints (maxClicks exceeded)", async () => {
      const { id: linkId } = await createTestLink({
        slug: "pw-maxclicks-post",
        destinationUrl: "https://example.com/maxed",
        password: passwordHash,
        maxClicks: 5,
        userId: owner.user.id,
      });
      await insertClickStat(linkId, 5, "2026-03-20");

      const res = await postPassword("pw-maxclicks-post", PASSWORD);

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("no longer available");
    });
  });

  // ── checkConstraints ───────────────────────────────────────────────────

  describe("checkConstraints – expired / maxClicks / internal", () => {
    it("GET with expiresAt in the past returns 410", async () => {
      const pastTs = new Date(Date.now() - 7_200_000);
      await createTestLink({
        slug: "expired-link",
        destinationUrl: "https://example.com/expired",
        expiresAt: pastTs,
        userId: owner.user.id,
      });

      const res = await api("GET", "/expired-link");

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("expired");
    });

    it("GET with maxClicks exceeded returns 410", async () => {
      const { id: linkId } = await createTestLink({
        slug: "maxclicks-link",
        destinationUrl: "https://example.com/maxed",
        maxClicks: 10,
        userId: owner.user.id,
      });
      await insertClickStat(linkId, 7, "2026-03-20");
      await insertClickStat(linkId, 5, "2026-03-21");

      const res = await api("GET", "/maxclicks-link");

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("no longer available");
    });

    it("GET with isInternal and no session returns 403", async () => {
      await createTestLink({
        slug: "internal-link",
        destinationUrl: "https://example.com/internal",
        isInternal: true,
        userId: owner.user.id,
      });

      const res = await api("GET", "/internal-link");

      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("requires authentication");
    });

    it("GET with isInternal and valid session redirects normally", async () => {
      await createTestLink({
        slug: "internal-authed",
        destinationUrl: "https://example.com/internal-ok",
        isInternal: true,
        userId: owner.user.id,
      });

      const res = await api("GET", "/internal-authed", { headers: { Cookie: owner.headers.Cookie } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/internal-ok");
    });
  });

  // ── bot / OG meta page ─────────────────────────────────────────────────

  describe("Bot OG meta page", () => {
    beforeAll(async () => {
      await createTestLink({
        slug: "og-link",
        destinationUrl: "https://example.com/og-dest",
        ogTitle: "My Link Title",
        ogDescription: "A description for social previews",
        ogImage: "https://example.com/og-image.png",
        userId: owner.user.id,
      });
      await createTestLink({
        slug: "og-pw-link",
        destinationUrl: "https://example.com/og-pw-dest",
        ogTitle: "Protected Link",
        ogDescription: "OG for a password link",
        ogImage: "https://example.com/og-pw.png",
        password: await hashPassword("test"),
        userId: owner.user.id,
      });
    });

    it("bot UA with OG data returns 200 HTML with og:* meta tags", async () => {
      const res = await api("GET", "/og-link", { headers: { "User-Agent": "facebookexternalhit/1.1" } });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta property="og:title" content="My Link Title">');
      expect(html).toContain('<meta property="og:description" content="A description for social previews">');
      expect(html).toContain('<meta property="og:image" content="https://example.com/og-image.png">');
      expect(html).toContain('<meta http-equiv="refresh" content="0;url=https://example.com/og-dest">');
    });

    it("bot UA on a link without OG data redirects and counts as a click", async () => {
      const { id: linkId } = await createTestLink({
        slug: "bot-no-og",
        destinationUrl: "https://example.com/bot-no-og",
        userId: owner.user.id,
      });

      const ctx = createExecutionContext();
      const res = await api("GET", "/bot-no-og", { headers: { "User-Agent": "facebookexternalhit/1.1" }, ctx });
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(302);
      expect(await totalClicks(linkId)).toBe(1);
    });

    it("normal UA with OG data redirects normally", async () => {
      const res = await api("GET", "/og-link", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/og-dest");
    });

    it("bot UA on password-protected link serves og:* tags but never the destination", async () => {
      const res = await api("GET", "/og-pw-link", { headers: { "User-Agent": "Twitterbot/1.0" } });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta property="og:title" content="Protected Link">');
      // The password gate is skipped for crawlers…
      expect(html).not.toContain("Enter password");
      // …but the destination must not leak through the meta refresh.
      expect(html).not.toContain("https://example.com/og-pw-dest");
      expect(html).not.toContain("http-equiv=\"refresh\"");
      // og:url still points at the short link.
      expect(html).toContain('<meta property="og:url" content="http://localhost/og-pw-link">');
    });
  });

  // ── handleCustomDomainRoot ─────────────────────────────────────────────

  describe("handleCustomDomainRoot", () => {
    beforeAll(async () => {
      await createTestDomain("custom-root.example.com", {
        rootRedirect: "https://example.com/root-dest",
      });
      await createTestDomain("custom-noroot.example.com", {
        rootRedirect: null,
      });
    });

    it("GET / with custom domain that has rootRedirect returns 302", async () => {
      const res = await api("GET", "/", { headers: { Host: "custom-root.example.com" } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/root-dest");
    });

    it.each([
      ["a custom domain with no rootRedirect", "custom-noroot.example.com"],
      ["a host with no domain_config row", "unknown-domain.example.com"],
      ["the primary host", "localhost"],
    ])("GET / on %s serves the SPA", async (_label, host) => {
      await expectSpaShell(await api("GET", "/", { headers: { Host: host } }));
    });
  });

  // ── custom domain notFoundRedirect ─────────────────────────────────────

  describe("Custom domain notFoundRedirect", () => {
    beforeAll(async () => {
      await createTestDomain("custom-nf.example.com", {
        notFoundRedirect: "https://example.com/not-found-page",
      });
      await createTestDomain("custom-nonf.example.com", {
        notFoundRedirect: null,
      });
    });

    it.each([
      ["an unknown slug", "/nonexistent-slug-nf"],
      ["/login, like any unknown slug", "/login"],
      ["a slug validateSlug rejects", "/a%7Cb"],
    ])("GET %s on a custom domain takes notFoundRedirect", async (_label, path) => {
      const res = await api("GET", path, { headers: { Host: "custom-nf.example.com" } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/not-found-page");
    });

    it("GET /login on the primary host serves the SPA", async () => {
      await expectSpaShell(await api("GET", "/login", { headers: { Host: "localhost" } }));
    });

    it("GET /nonexistent with no notFoundRedirect serves the SPA", async () => {
      await expectSpaShell(await api("GET", "/nonexistent-slug-nonf", { headers: { Host: "custom-nonf.example.com" } }));
    });
  });

  // ── isHttpUrl defense-in-depth: protocol smuggling ─────────────────────
  //
  // Only instance admins edit rootRedirect and notFoundRedirect, but a
  // javascript:, data: or malformed value in domain_config must never be honored.

  describe("isHttpUrl — domain_config values", () => {
    it.each([
      ["hostile-root.example.com", { rootRedirect: "javascript:alert(1)" }, "/"],
      ["hostile-data.example.com", { rootRedirect: "data:text/html,<script>alert(1)</script>" }, "/"],
      ["hostile-nf.example.com", { notFoundRedirect: "not a real url at all" }, "/some-missing-slug"],
      ["hostile-nf-js.example.com", { notFoundRedirect: "javascript:alert('xss')" }, "/also-missing"],
    ])("ignores an unsafe redirect on %s", async (hostname, config, path) => {
      await createTestDomain(hostname, config);

      await expectSpaShell(await api("GET", path, { headers: { Host: hostname } }));
    });
  });

  // ── domain-scoped slug lookup ──────────────────────────────────────────

  describe("Domain-scoped slug lookup", () => {
    beforeAll(async () => {
      await createTestDomain("scope.example.com");
      await createTestDomain("other.example.com");
      await createTestLink({
        slug: "shared-slug",
        destinationUrl: "https://example.com/custom-domain-dest",
        domainHostname: "scope.example.com",
        userId: owner.user.id,
      });
      await createTestLink({
        slug: "shared-slug",
        destinationUrl: "https://example.com/default-domain-dest",
        domainHostname: null,
        userId: owner.user.id,
      });
    });

    it("GET /:slug with matching custom domain Host redirects to domain-scoped destination", async () => {
      const res = await api("GET", "/shared-slug", { headers: { Host: "scope.example.com" } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/custom-domain-dest");
    });

    it("same slug on default domain redirects to default destination", async () => {
      const res = await api("GET", "/shared-slug", { headers: { Host: "localhost" } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/default-domain-dest");
    });

    it("GET /:slug on another custom domain does not find the slug", async () => {
      await expectSpaShell(await api("GET", "/shared-slug", { headers: { Host: "other.example.com" } }));
    });
  });

  // ── D1-path targeting resolution ───────────────────────────────────────

  describe("D1-path targeting resolution", () => {
    it("loads the link's targets from D1 on a cache miss", async () => {
      const { id: linkId } = await createTestLink({
        slug: "geo-target",
        destinationUrl: "https://example.com/default-geo",
        userId: owner.user.id,
      });
      await insertTarget({ linkId, type: "geo", matchValue: "DE", destinationUrl: "https://example.com/germany", priority: 10 });

      const res = await api("GET", "/geo-target", { cf: { country: "DE" } });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/germany");
    });
  });
});

describe("Redirect engine – password gate GET", () => {
  it("D1 path: serves the form with no Location header", async () => {
    await createTestLink({
      slug: "pw-gate-d1",
      destinationUrl: "https://example.com/pw-gate-d1-dest",
      password: await hashPassword("hunter2"),
      userId: owner.user.id,
    });

    const res = await api("GET", "/pw-gate-d1");

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This link is password protected");
    expect(html).toContain('<form method="POST" action="/pw-gate-d1">');
    expect(html).not.toContain("https://example.com/pw-gate-d1-dest");
  });

  it("gate CSP omits form-action so Chrome allows the redirect the POST returns", async () => {
    const res = await api("GET", "/pw-gate-d1");

    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("form-action");
    expect(csp).not.toContain("example.com");
  });

  it("KV-cached path: serves the form with no Location header", async () => {
    await setCachedRedirect(env.KV, "pw-gate-kv", cachedRedirect({
      url: "https://example.com/pw-gate-kv-dest",
      linkId: "pw-gate-kv-link",
      hasPassword: true,
    }));

    const res = await api("GET", "/pw-gate-kv");

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This link is password protected");
    expect(html).not.toContain("https://example.com/pw-gate-kv-dest");
  });
});

describe("Redirect engine – password POST rate limit", () => {
  // Date is frozen one second into a 900 s window, so all six attempts share one counter key.
  beforeEach(() => {
    vi.setSystemTime(Math.floor(Date.now() / 900_000) * 900_000 + 1_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 429 on the sixth attempt in a window", async () => {
    await createTestLink({
      slug: "pw-brute",
      destinationUrl: "https://example.com/pw-brute-dest",
      password: await hashPassword("correct-horse"),
      userId: owner.user.id,
    });

    const attempt = async (password: string) => {
      const ctx = createExecutionContext();
      const res = await postPassword("pw-brute", password, { headers: { "CF-Connecting-IP": "203.0.113.7" }, ctx });
      // The counter is written in waitUntil; await it so attempts are ordered.
      await waitOnExecutionContext(ctx);
      return res;
    };

    for (let i = 0; i < 5; i++) {
      const res = await attempt("wrong");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Incorrect password");
    }

    const sixth = await attempt("wrong");
    expect(sixth.status).toBe(429);
    expect(await sixth.text()).toContain("Too many attempts");
  });
});

describe("Redirect engine – hot-path invariants", () => {
  it("a password-gated request never rolls A/B, for a visitor or a crawler", async () => {
    await setCachedRedirect(env.KV, "pw-ab-kv", cachedRedirect({
      url: "https://example.com/pw-ab-default",
      hasPassword: true,
      ogTitle: "Gated",
      targets: [{ type: "ab", matchValue: "50", destinationUrl: "https://example.com/pw-ab-variant", priority: 0 }],
    }));
    const random = vi.spyOn(Math, "random");

    const visitor = await api("GET", "/pw-ab-kv");
    const crawler = await api("GET", "/pw-ab-kv", { headers: { "User-Agent": "Twitterbot/1.0" } });

    expect(visitor.status).toBe(200);
    expect(await visitor.text()).toContain("This link is password protected");
    expect(crawler.status).toBe(200);
    expect(random).not.toHaveBeenCalled();
  });

  it("a password POST reads link_targets only once the password verifies", async () => {
    const { id: linkId } = await createTestLink({
      slug: "pw-targets-late",
      destinationUrl: "https://example.com/pw-targets-default",
      password: await hashPassword("late-targets"),
      userId: owner.user.id,
    });
    await insertTarget({ linkId, type: "geo", matchValue: "DE", destinationUrl: "https://example.com/pw-targets-de", priority: 1 });
    const prepare = vi.spyOn(env.DB, "prepare");
    const targetReads = () => prepare.mock.calls.filter(([sql]) => sql.includes("link_targets")).length;

    for (const password of ["", "wrong"]) {
      expect((await postPassword("pw-targets-late", password)).status).toBe(200);
    }
    expect(targetReads()).toBe(0);

    expect((await postPassword("pw-targets-late", "late-targets")).status).toBe(302);
    expect(targetReads()).toBe(1);
  });

  it("a cached entry with maxClicks counts link_stats in D1 and answers 410 once the cap is reached", async () => {
    // The D1 row has no cap, so the 410 comes from the cached maxClicks plus the D1 count.
    const { id: linkId } = await createTestLink({
      slug: "kv-capped",
      destinationUrl: "https://example.com/kv-capped",
      userId: owner.user.id,
    });
    await setCachedRedirect(env.KV, "kv-capped", cachedRedirect({ url: "https://example.com/kv-capped", linkId, maxClicks: 3 }));
    await insertClickStat(linkId, 2, isoDaysAgo(1));

    const ctx = createExecutionContext();
    const first = await api("GET", "/kv-capped", { ctx });
    await waitOnExecutionContext(ctx);
    expect(first.status).toBe(302);

    const second = await api("GET", "/kv-capped");
    expect(second.status).toBe(410);
  });

  it("a miss on a custom domain fills the domain-scoped KV key and not the bare one", async () => {
    await createTestDomain("fill.example.com");
    await createTestLink({
      slug: "fill-scope",
      destinationUrl: "https://example.com/fill-scope",
      domainHostname: "fill.example.com",
      userId: owner.user.id,
    });

    const ctx = createExecutionContext();
    const res = await api("GET", "/fill-scope", { headers: { Host: "fill.example.com" }, ctx });
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(302);
    expect((await getCachedRedirect(env.KV, "fill-scope", "fill.example.com"))?.url).toBe("https://example.com/fill-scope");
    expect(await getCachedRedirect(env.KV, "fill-scope")).toBeNull();
  });

  it("a slug validateSlug rejects falls through on the primary host without a KV or D1 lookup", async () => {
    // Only a planted entry can hold such a slug.
    await setCachedRedirect(env.KV, "a|b", cachedRedirect({ url: "https://example.com/invalid-slug" }));

    await expectSpaShell(await api("GET", "/a%7Cb"));
  });
});
